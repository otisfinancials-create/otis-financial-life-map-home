import { Router, type IRouter } from "express";
import { eq, and, desc, isNotNull, inArray, gte } from "drizzle-orm";
import {
  db,
  billsTable,
  forecastedTransactionsTable,
  accountsTable,
  cardCycleBillsTable,
  cardCyclesTable,
  envelopeAllocationsTable,
  plaidTransactionsTable,
} from "@workspace/db";
import { syncBillWithCycles, detachBillFromAllCycles, refreshClosedCycles } from "../services/bill-cycle-sync";
import { merchantMatchStrength } from "../services/cycle-processing";
import { listBillLinkReview, suggestForBillLike, listAccountMerchants } from "../services/bill-merchant-suggest";
import {
  GetBillLinkReviewResponse,
  ListAccountMerchantsQueryParams,
  ListAccountMerchantsResponse,
  SuggestBillMerchantsBody,
  SuggestBillMerchantsResponse,
  GetBillMatchingChargesParams,
  GetBillMatchingChargesResponse,
  LinkBillMerchantParams,
  LinkBillMerchantBody,
  LinkBillMerchantResponse,
  CreateBillBody,
  UpdateBillBody,
  GetBillParams,
  UpdateBillParams,
  DeleteBillParams,
  ListBillsResponse,
  CreateBillResponse,
  GetBillResponse,
  UpdateBillResponse,
  GetUpcomingBillsResponse,
  ListBillPaymentStatsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// For non-monthly bills the due day is defined by the first bill date, so keep
// `dueDay` in sync with `startDate` server-side (clients may not set it, and
// `/bills/upcoming` and due-day displays depend on it being consistent).
function canonicalizeDueDay<T extends { frequency?: string | null; startDate?: string | null; dueDay?: number | null }>(
  data: T,
): T {
  if (data.frequency && data.frequency !== "monthly" && data.startDate) {
    const day = Number(data.startDate.slice(8, 10));
    if (!Number.isNaN(day)) return { ...data, dueDay: day };
  }
  return data;
}

// The full cadence set bills support. Anything else is rejected at the API
// boundary — the forecast stepper THROWS on unknown frequencies (no silent
// monthly fallback), so bad values must never reach the table.
const BILL_FREQUENCIES = new Set([
  "weekly", "biweekly", "semi-monthly", "monthly", "quarterly", "semi-annual", "annual", "annually", "custom",
]);
// Sane lower bound on bill start dates — a year-0026 typo once burned 5000
// stepper iterations per regeneration.
const MIN_BILL_START_DATE = "2000-01-01";

/**
 * Validate cadence-related fields on create/update. Returns an error string
 * or null. `existing` supplies current values for partial updates.
 */
export function validateBillCadence(
  data: { frequency?: string | null; customIntervalDays?: number | null; startDate?: string | null },
  existing?: { frequency: string; customIntervalDays: number | null },
): string | null {
  const frequency = data.frequency ?? existing?.frequency;
  if (data.frequency != null && !BILL_FREQUENCIES.has(data.frequency.toLowerCase())) {
    return `Unknown frequency "${data.frequency}". Supported: weekly, biweekly, semi-monthly, monthly, quarterly, semi-annual, annual, custom.`;
  }
  const interval = data.customIntervalDays !== undefined ? data.customIntervalDays : existing?.customIntervalDays ?? null;
  if (frequency?.toLowerCase() === "custom") {
    if (interval == null || !Number.isInteger(interval) || interval < 1 || interval > 3650) {
      return "A custom frequency requires customIntervalDays between 1 and 3650.";
    }
  } else if (data.customIntervalDays != null) {
    return "customIntervalDays is only allowed when frequency is 'custom'.";
  }
  if (data.startDate != null && data.startDate < MIN_BILL_START_DATE) {
    return `Start date ${data.startDate} is before ${MIN_BILL_START_DATE} — check for a year typo.`;
  }
  return null;
}

/**
 * Normalize a user-supplied match merchant the same way the matcher
 * normalizes transaction names, so stored keys and match-time keys line up.
 * Empty/whitespace-only input clears the link (null).
 */
export function normalizeMatchMerchant(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined; // not part of this request
  if (raw === null) return null;
  const norm = raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return norm || null;
}

/** Reject paymentAccountId values that don't belong to the requesting user. */
export async function paymentAccountBelongsToUser(userId: string, paymentAccountId: number | null | undefined): Promise<boolean> {
  if (paymentAccountId == null) return true;
  const [account] = await db
    .select({ id: accountsTable.id })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, paymentAccountId), eq(accountsTable.userId, userId)));
  return !!account;
}

router.get("/bills", async (req, res): Promise<void> => {
  req.log.info("Fetching bills");
  const bills = await db
    .select()
    .from(billsTable)
    .where(eq(billsTable.userId, req.userId))
    .orderBy(billsTable.billName);
  res.json(ListBillsResponse.parse(bills.map(serializeBill)));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = canonicalizeDueDay(parsed.data);
  const cadenceError = validateBillCadence(data);
  if (cadenceError) {
    res.status(400).json({ error: cadenceError });
    return;
  }
  if (!(await paymentAccountBelongsToUser(req.userId, data.paymentAccountId))) {
    res.status(400).json({ error: "Invalid paying account" });
    return;
  }
  const [bill] = await db.insert(billsTable).values({
    ...data,
    matchMerchant: normalizeMatchMerchant(data.matchMerchant),
    userId: req.userId,
    amount: String(data.amount),
    // Upkeep amounts are estimates by nature (vet visits, HVAC service vary),
    // so upkeep defaults to variable — reconciliation then matches on
    // merchant + account + date and ignores amount.
    isVariable: data.isVariable ?? (data.billKind === "upkeep"),
    isActive: data.isActive ?? true,
  }).returning();
  // Real-time cycle sync: a new card bill must appear in its card's open
  // cycles immediately. A sync failure is surfaced (503), not swallowed —
  // the bill IS saved, so the client should refresh rather than re-create.
  if (bill.paymentAccountId != null) {
    try {
      const sync = await syncBillWithCycles({ userId: req.userId, billId: bill.id });
      req.log.info({ sync }, "bill-cycle sync after create");
    } catch (err) {
      req.log.error({ err }, "bill-cycle sync failed after create");
      res.status(503).json({ error: "Bill was saved, but updating its card cycles failed. Refresh and retry — do not re-create the bill.", billId: bill.id });
      return;
    }
  }
  res.status(201).json(CreateBillResponse.parse(serializeBill(bill)));
});

// Historical payment stats per bill. Two disjoint sources by construction:
// bank-paid bills reconcile onto forecast rows (matched_plaid_transaction_id
// set), while card-paid bills accrue actuals on card_cycle_bills (status
// 'hit') — bank reconciliation explicitly excludes credit-card payment
// accounts, so no payment can appear in both. Literal path: MUST stay above
// the /bills/:id param routes.
router.get("/bills/payment-stats", async (req, res): Promise<void> => {
  const bills = await db
    .select({
      id: billsTable.id,
      frequency: billsTable.frequency,
      isVariable: billsTable.isVariable,
      customIntervalDays: billsTable.customIntervalDays,
      amount: billsTable.amount,
      matchMerchant: billsTable.matchMerchant,
      paymentAccountId: billsTable.paymentAccountId,
    })
    .from(billsTable)
    .where(eq(billsTable.userId, req.userId));

  // Bank-paid: reconciled forecast rows for a bill (actual + linked to a
  // posted transaction). Amounts here are the settled posted amounts.
  const bankRows = await db
    .select({
      billId: forecastedTransactionsTable.sourceBillId,
      amount: forecastedTransactionsTable.amount,
      date: forecastedTransactionsTable.transactionDate,
      matchedPlaidTransactionId: forecastedTransactionsTable.matchedPlaidTransactionId,
    })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      eq(forecastedTransactionsTable.isActual, true),
      isNotNull(forecastedTransactionsTable.sourceBillId),
      isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
    ));

  // Card-paid: each 'hit' cycle-bill row is one payment occurrence; its
  // actual_amount already sums that cycle's matched charges. Dated by the
  // cycle close (the statement the charge belongs to).
  const cardRows = await db
    .select({
      billId: cardCycleBillsTable.billId,
      amount: cardCycleBillsTable.actualAmount,
      date: cardCyclesTable.cycleEnd,
    })
    .from(cardCycleBillsTable)
    .innerJoin(cardCyclesTable, eq(cardCycleBillsTable.cardCycleId, cardCyclesTable.id))
    .innerJoin(billsTable, eq(cardCycleBillsTable.billId, billsTable.id))
    .where(and(
      eq(billsTable.userId, req.userId),
      eq(cardCycleBillsTable.status, "hit"),
      isNotNull(cardCycleBillsTable.actualAmount),
    ));

  type Acc = { amounts: number[]; dates: string[]; bank: number; card: number; inferred: number };
  const byBill = new Map<number, Acc>();
  const acc = (billId: number): Acc => {
    let a = byBill.get(billId);
    if (!a) { a = { amounts: [], dates: [], bank: 0, card: 0, inferred: 0 }; byBill.set(billId, a); }
    return a;
  };
  for (const r of bankRows) {
    if (r.billId == null) continue;
    const a = acc(r.billId);
    a.amounts.push(Math.abs(parseFloat(String(r.amount))));
    a.dates.push(r.date);
    a.bank++;
  }
  for (const r of cardRows) {
    const a = acc(r.billId);
    a.amounts.push(Math.abs(parseFloat(String(r.amount))));
    a.dates.push(r.date);
    a.card++;
  }

  // ---- Inferred history from full Plaid transaction data (up to 730 days).
  // Confirmed links (reconciled forecast rows / card-cycle allocations) take
  // precedence: any transaction already linked to a bill is excluded here so
  // nothing is counted twice. Only STRONG merchant matches are used —
  // accuracy over coverage, since a wrong match silently corrupts the average.
  const confirmedTxnIds = new Set<string>();
  // Bank links store the plaid_transactions integer id; map them to the text id.
  const bankLinkIds = bankRows.map((r) => r.matchedPlaidTransactionId).filter((x): x is number => x != null);
  if (bankLinkIds.length > 0) {
    const rows = await db
      .select({ txnId: plaidTransactionsTable.plaidTransactionId })
      .from(plaidTransactionsTable)
      .where(and(eq(plaidTransactionsTable.userId, req.userId), inArray(plaidTransactionsTable.id, bankLinkIds)));
    for (const r of rows) confirmedTxnIds.add(r.txnId);
  }
  // Card links: allocations tied to a card_cycle_bill carry the charge's text id.
  const cardAllocRows = await db
    .select({ txnId: envelopeAllocationsTable.plaidTransactionId })
    .from(envelopeAllocationsTable)
    .where(and(eq(envelopeAllocationsTable.userId, req.userId), isNotNull(envelopeAllocationsTable.cardCycleBillId)));
  for (const r of cardAllocRows) if (r.txnId != null) confirmedTxnIds.add(r.txnId);

  // Candidate bills: need a merchant pattern and a Plaid-linked payment
  // account. Fixed bills with a non-positive amount are excluded — the ±50%
  // amount gate is meaningless at $0 and would admit any strong match.
  const inferable = bills.filter((b) =>
    b.matchMerchant
    && b.paymentAccountId != null
    && (b.isVariable || Math.abs(parseFloat(String(b.amount))) > 0),
  );
  const accountIds = [...new Set(inferable.map((b) => b.paymentAccountId!))];
  const accounts = accountIds.length > 0
    ? await db
        .select({ id: accountsTable.id, plaidAccountId: accountsTable.plaidAccountId })
        .from(accountsTable)
        .where(and(eq(accountsTable.userId, req.userId), inArray(accountsTable.id, accountIds)))
    : [];
  const plaidAcctByAccountId = new Map(accounts.filter((a) => a.plaidAccountId != null).map((a) => [a.id, a.plaidAccountId!]));
  const plaidAcctIds = [...new Set(plaidAcctByAccountId.values())];
  const txns = plaidAcctIds.length > 0
    ? await db
        .select({
          plaidTransactionId: plaidTransactionsTable.plaidTransactionId,
          accountId: plaidTransactionsTable.accountId,
          amount: plaidTransactionsTable.amount,
          date: plaidTransactionsTable.date,
          name: plaidTransactionsTable.name,
          merchantName: plaidTransactionsTable.merchantName,
        })
        .from(plaidTransactionsTable)
        .where(and(
          eq(plaidTransactionsTable.userId, req.userId),
          eq(plaidTransactionsTable.pending, false),
          inArray(plaidTransactionsTable.accountId, plaidAcctIds),
          // Plaid link tokens request at most 730 days of history; bound the
          // scan so it never grows past that window.
          gte(plaidTransactionsTable.date, new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10)),
        ))
    : [];

  for (const txn of txns) {
    if (confirmedTxnIds.has(txn.plaidTransactionId)) continue;
    const amt = Math.abs(parseFloat(String(txn.amount)));
    if (parseFloat(String(txn.amount)) <= 0) continue; // Plaid: positive = outflow; skip refunds/credits
    // A transaction is assigned to at most ONE bill. When several bills on the
    // same account share a merchant pattern (e.g. two USAA policies), pick the
    // bill whose amount is closest; a tie means ambiguity — exclude the txn.
    let best: { bill: (typeof inferable)[number]; dist: number } | null = null;
    let tied = false;
    for (const b of inferable) {
      if (plaidAcctByAccountId.get(b.paymentAccountId!) !== txn.accountId) continue;
      if (merchantMatchStrength(b.matchMerchant!, txn) !== "strong") continue;
      const billAmt = Math.abs(parseFloat(String(b.amount)));
      // Fixed bills: require the charge within ±50% of the bill amount so an
      // unrelated charge from the same merchant can't skew the average.
      if (!b.isVariable && billAmt > 0 && (amt < billAmt * 0.5 || amt > billAmt * 1.5)) continue;
      const dist = billAmt > 0 ? Math.abs(amt - billAmt) : 0;
      if (best == null || dist < best.dist) { best = { bill: b, dist }; tied = false; }
      else if (dist === best.dist && best.bill.id !== b.id) tied = true;
    }
    if (best == null || tied) continue;
    const a = acc(best.bill.id);
    a.amounts.push(amt);
    a.dates.push(txn.date);
    a.inferred++;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  res.json(ListBillPaymentStatsResponse.parse({
    stats: bills.map((b) => {
      const a = byBill.get(b.id);
      if (!a || a.amounts.length === 0) {
        return { billId: b.id, frequency: b.frequency, isVariable: b.isVariable ?? false, customIntervalDays: b.customIntervalDays ?? null, count: 0, totalPaid: 0, average: null, minAmount: null, maxAmount: null, firstDate: null, lastDate: null, cardPayments: 0, bankPayments: 0, inferredPayments: 0 };
      }
      const total = a.amounts.reduce((s, x) => s + x, 0);
      const dates = [...a.dates].sort();
      return {
        billId: b.id,
        frequency: b.frequency,
        isVariable: b.isVariable ?? false,
        customIntervalDays: b.customIntervalDays ?? null,
        count: a.amounts.length,
        totalPaid: round2(total),
        average: a.amounts.length >= 2 ? round2(total / a.amounts.length) : null,
        minAmount: round2(Math.min(...a.amounts)),
        maxAmount: round2(Math.max(...a.amounts)),
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        cardPayments: a.card,
        bankPayments: a.bank,
        inferredPayments: a.inferred,
      };
    }),
  }));
});

router.get("/bills/upcoming", async (req, res): Promise<void> => {
  const today = new Date();
  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), eq(billsTable.userId, req.userId)));

  const upcoming = bills
    .map((bill) => {
      const dueDay = bill.dueDay;
      let dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      if (dueDate < today) {
        dueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
      }
      const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return {
        id: bill.id,
        billName: bill.billName,
        category: bill.category,
        amount: parseFloat(String(bill.amount)),
        dueDate: dueDate.toISOString().split("T")[0],
        daysUntilDue,
        paymentMethod: bill.paymentMethod,
      };
    })
    .filter((b) => b.daysUntilDue <= 30)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  res.json(GetUpcomingBillsResponse.parse(upcoming));
});

// Real-merchant picker source: distinct merchants from posted charges on an
// account. Registered before /bills/:id.
router.get("/bills/account-merchants", async (req, res): Promise<void> => {
  const parsed = ListAccountMerchantsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const merchants = await listAccountMerchants(req.userId, parsed.data.accountId);
  if (merchants === null) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(ListAccountMerchantsResponse.parse(merchants));
});

// Merchant suggestions for the bill form (create OR edit — the bill may not
// be saved yet, so the caller sends the bill-like fields). Must be
// registered before /bills/:id.
router.post("/bills/suggest-merchants", async (req, res): Promise<void> => {
  const parsed = SuggestBillMerchantsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const candidates = await suggestForBillLike(req.userId, parsed.data);
  res.json(SuggestBillMerchantsResponse.parse(candidates));
});

// P5.5 one-time "link existing bills" pass — must be registered before
// /bills/:id so "link-review" isn't parsed as a bill id.
router.get("/bills/link-review", async (req, res): Promise<void> => {
  const items = await listBillLinkReview(req.userId);
  res.json(GetBillLinkReviewResponse.parse(items.map((item) => ({
    bill: serializeBill(item.bill),
    accountName: item.accountName,
    candidates: item.candidates,
  }))));
});

router.post("/bills/:id/link-merchant", async (req, res): Promise<void> => {
  const params = LinkBillMerchantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = LinkBillMerchantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Store the merchant normalized the same way the matcher normalizes
  // transaction names, so stored keys and match-time keys line up.
  const matchMerchant = parsed.data.matchMerchant
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!matchMerchant) {
    res.status(400).json({ error: "Merchant name must contain letters or digits" });
    return;
  }
  const [bill] = await db
    .update(billsTable)
    .set({ matchMerchant, updatedAt: new Date() })
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  // Immediate effect: re-run matching on the card's open cycles so the
  // charge leaves Misc and lands on the bill line right away.
  if (bill.paymentAccountId != null) {
    try {
      const sync = await syncBillWithCycles({ userId: req.userId, billId: bill.id });
      req.log.info({ sync }, "bill-cycle sync after merchant link");
    } catch (err) {
      req.log.error({ err }, "bill-cycle sync failed after merchant link");
      res.status(503).json({ error: "Merchant was saved, but re-matching the card cycles failed. Reprocess the cycle to refresh.", billId: bill.id });
      return;
    }
  }
  res.json(LinkBillMerchantResponse.parse(serializeBill(bill)));
});

// "Currently matching" preview: the charges presently allocated to this
// bill's line across its card's cycles (newest first).
router.get("/bills/:id/matching-charges", async (req, res): Promise<void> => {
  const params = GetBillMatchingChargesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [bill] = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  const rows = await db
    .select({
      date: plaidTransactionsTable.date,
      amount: plaidTransactionsTable.amount,
      merchantName: plaidTransactionsTable.merchantName,
      name: plaidTransactionsTable.name,
    })
    .from(envelopeAllocationsTable)
    .innerJoin(cardCycleBillsTable, eq(envelopeAllocationsTable.cardCycleBillId, cardCycleBillsTable.id))
    .innerJoin(plaidTransactionsTable, eq(envelopeAllocationsTable.plaidTransactionId, plaidTransactionsTable.plaidTransactionId))
    .where(and(
      eq(cardCycleBillsTable.billId, params.data.id),
      eq(envelopeAllocationsTable.userId, req.userId),
    ))
    .orderBy(desc(plaidTransactionsTable.date))
    .limit(10);
  res.json(GetBillMatchingChargesResponse.parse(rows.map((r) => ({
    date: r.date,
    amount: parseFloat(String(r.amount)),
    description: r.merchantName || r.name || "",
  }))));
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const params = GetBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [bill] = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(GetBillResponse.parse(serializeBill(bill)));
});

router.patch("/bills/:id", async (req, res): Promise<void> => {
  const params = UpdateBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Canonicalize dueDay when frequency + startDate are being set together.
  const canonicalized = canonicalizeDueDay(parsed.data);
  if (!(await paymentAccountBelongsToUser(req.userId, canonicalized.paymentAccountId))) {
    res.status(400).json({ error: "Invalid paying account" });
    return;
  }
  // Capture the pre-update paying account so a moved bill leaves the old
  // card's cycles as part of the sync.
  const [before] = await db
    .select({
      paymentAccountId: billsTable.paymentAccountId,
      billKind: billsTable.billKind,
      frequency: billsTable.frequency,
      customIntervalDays: billsTable.customIntervalDays,
    })
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
  if (before) {
    const cadenceError = validateBillCadence(canonicalized, before);
    if (cadenceError) {
      res.status(400).json({ error: cadenceError });
      return;
    }
  }
  // Goal contribution bills are managed exclusively by the goal lifecycle
  // (commit/uncommit/edit-goal) — generic bill edits could make them
  // card-paid or break the goal↔bill linkage.
  if (before?.billKind === "goal_contribution") {
    res.status(400).json({ error: "This is a goal contribution — edit it from the Goals page instead." });
    return;
  }
  // Server-authoritative cadence transition: switching to a non-custom
  // frequency clears the interval even when the client omits the field, so a
  // stale interval can never be silently reused on a later switch back.
  const effectiveFrequency = canonicalized.frequency ?? before?.frequency;
  const cadenceNormalized =
    effectiveFrequency != null && effectiveFrequency.toLowerCase() !== "custom"
      ? { ...canonicalized, customIntervalDays: null }
      : canonicalized;
  const { amount: rawBillAmount, matchMerchant: rawMatchMerchant, ...restBillData } = cadenceNormalized;
  const matchMerchant = normalizeMatchMerchant(rawMatchMerchant);
  const [bill] = await db
    .update(billsTable)
    .set({
      ...restBillData,
      ...(rawBillAmount !== undefined && { amount: String(rawBillAmount) }),
      ...(matchMerchant !== undefined && { matchMerchant }),
      updatedAt: new Date(),
    })
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  // Real-time cycle sync for edits: amount/due-day changes refresh pending
  // cycle rows; account changes / deactivation remove the bill from cycles
  // it no longer belongs to (reconciled rows are kept and flagged).
  if (bill.paymentAccountId != null || before?.paymentAccountId != null) {
    try {
      const sync = await syncBillWithCycles({
        userId: req.userId,
        billId: bill.id,
        previousAccountId: before?.paymentAccountId ?? null,
      });
      req.log.info({ sync }, "bill-cycle sync after update");
    } catch (err) {
      req.log.error({ err }, "bill-cycle sync failed after update");
      res.status(503).json({ error: "Bill was updated, but updating its card cycles failed. Refresh and retry the edit.", billId: bill.id });
      return;
    }
  }
  res.json(UpdateBillResponse.parse(serializeBill(bill)));
});

router.delete("/bills/:id", async (req, res): Promise<void> => {
  const params = DeleteBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  // Never hard-delete a goal contribution through the generic path — the
  // goal lifecycle (uncommit) owns removal and preserves reconciled history.
  if (existing.billKind === "goal_contribution") {
    res.status(400).json({ error: "This is a goal contribution — uncommit the goal from the Goals page instead." });
    return;
  }

  // Atomic hard delete: detach from every cycle (card_cycle_bills.bill_id
  // has no cascade; reconciled actuals move to the catch-all — keep the
  // actual, detach the plan), then remove forecasted transactions and the
  // bill itself, all in ONE transaction so a failure can't leave the bill
  // half-detached.
  const deleted = await db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(billsTable)
      .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
    if (!bill) return null;

    const detach = await detachBillFromAllCycles(tx, req.userId, params.data.id);
    if (detach.detachedAllocations > 0) {
      req.log.info({ detach, billId: params.data.id }, "reconciled bill allocations moved to catch-all on delete");
    }

    await tx
      .delete(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.sourceBillId, params.data.id),
        eq(forecastedTransactionsTable.userId, req.userId),
      ));
    await tx
      .delete(billsTable)
      .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
    return { bill, closedCyclesToRecompute: detach.closedCyclesToRecompute, openCyclesToReprocess: detach.openCyclesToReprocess };
  });

  if (!deleted) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  // Post-commit recomputes (derived data, idempotent — safe to retry):
  // closed cycles whose reconciled allocations moved to the catch-all, then
  // the affected card's open cycles so totals reflect the removal.
  try {
    await refreshClosedCycles(deleted.closedCyclesToRecompute);
    if (existing.paymentAccountId != null || deleted.openCyclesToReprocess.length > 0) {
      const sync = await syncBillWithCycles({
        userId: req.userId,
        billId: params.data.id,
        previousAccountId: existing.paymentAccountId,
        deleted: true,
        extraCycleIds: deleted.openCyclesToReprocess,
      });
      req.log.info({ sync }, "bill-cycle sync after delete");
    }
  } catch (err) {
    req.log.error({ err }, "bill-cycle sync failed after delete");
    res.status(503).json({ error: "Bill was deleted, but updating its card cycles failed. Reprocess the cycle to refresh totals." });
    return;
  }
  res.sendStatus(204);
});

function serializeBill(bill: typeof billsTable.$inferSelect) {
  return {
    ...bill,
    amount: parseFloat(String(bill.amount)),
    createdAt: bill.createdAt.toISOString(),
    updatedAt: bill.updatedAt.toISOString(),
  };
}

export default router;
