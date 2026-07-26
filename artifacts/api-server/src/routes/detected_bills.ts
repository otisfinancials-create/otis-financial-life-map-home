import { Router, type IRouter } from "express";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  db,
  detectedBillsTable,
  billsTable,
  accountsTable,
  plaidTransactionsTable,
  type DetectedBill,
} from "@workspace/db";
import {
  DetectBillsResponse,
  ListDetectedBillsResponse,
  ListDetectedBillDraftsResponse,
  ConfirmDetectedBillParams,
  ConfirmDetectedBillBody,
  ConfirmDetectedBillResponse,
  DismissDetectedBillParams,
  DismissDetectedBillResponse,
  suggestCategoryFromPlaid,
} from "@workspace/api-zod";
import { detectBills, baseMerchantKey } from "../services/bill-detection";
import { syncBillWithCycles } from "../services/bill-cycle-sync";
import { normalizeMatchMerchant, paymentAccountBelongsToUser } from "./bills";

const router: IRouter = Router();

/** Detection cadence "annual" ↔ bills cadence "annually". */
function toBillFrequency(detectedFrequency: string): string {
  return detectedFrequency === "annual" ? "annually" : detectedFrequency;
}

function dueDayFrom(det: DetectedBill): number {
  const source = det.nextExpectedDate ?? det.lastSeen;
  const parsed = source ? Number(source.slice(8, 10)) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : 1;
}

type SampleTxn = {
  plaidTransactionId: string;
  accountId: string;
  date: string;
  amount: string;
  name: string | null;
  merchantName: string | null;
  primary: string | null;
  detailed: string | null;
};

async function loadSampleTxns(userId: string, sampleTxnIds: string[]): Promise<SampleTxn[]> {
  if (sampleTxnIds.length === 0) return [];
  return db
    .select({
      plaidTransactionId: plaidTransactionsTable.plaidTransactionId,
      accountId: plaidTransactionsTable.accountId,
      date: plaidTransactionsTable.date,
      amount: plaidTransactionsTable.amount,
      name: plaidTransactionsTable.name,
      merchantName: plaidTransactionsTable.merchantName,
      primary: plaidTransactionsTable.personalFinanceCategory,
      detailed: plaidTransactionsTable.personalFinanceCategoryDetailed,
    })
    .from(plaidTransactionsTable)
    .where(
      and(
        eq(plaidTransactionsTable.userId, userId),
        inArray(plaidTransactionsTable.plaidTransactionId, sampleTxnIds),
      ),
    );
}

/**
 * Suggest an Otis category from the sample transactions' Plaid
 * personal_finance_category. Deterministic: most-common primary wins, ties
 * break lexicographically; for the winning primary the most-common detailed
 * value (same tie-break) feeds the override mapping.
 */
function suggestCategoryFromSamples(txns: Array<Pick<SampleTxn, "primary" | "detailed">>): string {
  const primaryCounts = new Map<string, number>();
  for (const t of txns) {
    if (!t.primary) continue;
    primaryCounts.set(t.primary, (primaryCounts.get(t.primary) ?? 0) + 1);
  }
  const bestPrimary = [...primaryCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  if (!bestPrimary) return "Other";
  const detailedCounts = new Map<string, number>();
  for (const t of txns) {
    if (t.primary !== bestPrimary || !t.detailed) continue;
    detailedCounts.set(t.detailed, (detailedCounts.get(t.detailed) ?? 0) + 1);
  }
  const bestDetailed =
    [...detailedCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    null;
  return suggestCategoryFromPlaid(bestPrimary, bestDetailed);
}

/** Most-common Plaid account_id among the samples (deterministic tie-break). */
function dominantPlaidAccountId(txns: SampleTxn[]): string | null {
  const counts = new Map<string, number>();
  for (const t of txns) counts.set(t.accountId, (counts.get(t.accountId) ?? 0) + 1);
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  );
}

function sampleTxnIdsOf(det: DetectedBill): string[] {
  return Array.isArray(det.sampleTxnIds) ? (det.sampleTxnIds as string[]) : [];
}

function serializeDetected(row: DetectedBill) {
  return {
    id: row.id,
    merchantKey: row.merchantKey,
    displayName: row.displayName,
    amount: parseFloat(String(row.amount)),
    amountMin: row.amountMin === null ? null : parseFloat(String(row.amountMin)),
    amountMax: row.amountMax === null ? null : parseFloat(String(row.amountMax)),
    isVariable: row.isVariable,
    frequency: row.frequency,
    occurrenceCount: row.occurrenceCount,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    nextExpectedDate: row.nextExpectedDate,
    confidence: parseFloat(String(row.confidence)),
    status: row.status,
    duplicateOf: row.duplicateOf,
  };
}

router.post("/bills/detect", async (req, res): Promise<void> => {
  req.log.info("Running bill detection");
  const summary = await detectBills(req.userId);
  req.log.info(summary, "Bill detection run complete");
  res.json(
    DetectBillsResponse.parse({
      detected: summary.detected,
      pending: summary.pending,
      duplicates: summary.duplicates,
      excludedTransfers: summary.excludedTransfers,
      mergesPerformed: summary.mergesPerformed,
      excludedByMerchantPattern: summary.excludedByMerchantPattern,
    }),
  );
});

router.get("/bills/detected", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(detectedBillsTable)
    .where(
      and(eq(detectedBillsTable.userId, req.userId), inArray(detectedBillsTable.status, ["pending", "duplicate"])),
    )
    .orderBy(desc(detectedBillsTable.confidence));
  res.json(ListDetectedBillsResponse.parse(rows.map(serializeDetected)));
});

/**
 * Onboarding draft list: pending/duplicate detections enriched into
 * pre-filled, pre-linked bill drafts — suggested category (Plaid mapping),
 * paying account (dominant account among sample charges), normalized
 * match merchant, and sample-charge evidence.
 */
router.get("/bills/detected-drafts", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(detectedBillsTable)
    .where(
      and(eq(detectedBillsTable.userId, req.userId), inArray(detectedBillsTable.status, ["pending", "duplicate"])),
    )
    .orderBy(desc(detectedBillsTable.confidence), detectedBillsTable.id);

  // One batched lookup for all sample transactions across all drafts.
  const allTxnIds = [...new Set(rows.flatMap(sampleTxnIdsOf))];
  const allTxns = await loadSampleTxns(req.userId, allTxnIds);
  const txnById = new Map(allTxns.map((t) => [t.plaidTransactionId, t]));

  // Map dominant Plaid account_ids -> user's account rows.
  const accounts = await db
    .select({ id: accountsTable.id, name: accountsTable.accountName, plaidAccountId: accountsTable.plaidAccountId })
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId));
  const accountByPlaidId = new Map(
    accounts.filter((a) => a.plaidAccountId).map((a) => [a.plaidAccountId as string, a]),
  );

  // Duplicate labels: name of the bill each duplicate detection points at.
  const dupBillIds = [...new Set(rows.map((r) => r.duplicateOf).filter((v): v is number => v != null))];
  const dupBills = dupBillIds.length
    ? await db
        .select({ id: billsTable.id, billName: billsTable.billName })
        .from(billsTable)
        .where(and(eq(billsTable.userId, req.userId), inArray(billsTable.id, dupBillIds)))
    : [];
  const dupNameById = new Map(dupBills.map((b) => [b.id, b.billName]));

  const drafts = rows.map((det) => {
    const txns = sampleTxnIdsOf(det)
      .map((id) => txnById.get(id))
      .filter((t): t is SampleTxn => !!t);
    const plaidAccountId = dominantPlaidAccountId(txns);
    const account = plaidAccountId ? accountByPlaidId.get(plaidAccountId) : undefined;
    const evidence = [...txns]
      .sort((a, b) => b.date.localeCompare(a.date) || a.plaidTransactionId.localeCompare(b.plaidTransactionId))
      .slice(0, 4)
      .map((t) => ({
        date: t.date,
        amount: Math.abs(parseFloat(String(t.amount))),
        name: t.merchantName ?? t.name ?? det.displayName,
      }));
    return {
      id: det.id,
      displayName: det.displayName,
      matchMerchant: normalizeMatchMerchant(baseMerchantKey(det.merchantKey)) ?? baseMerchantKey(det.merchantKey),
      amount: parseFloat(String(det.amount)),
      amountMin: det.amountMin === null ? null : parseFloat(String(det.amountMin)),
      amountMax: det.amountMax === null ? null : parseFloat(String(det.amountMax)),
      isVariable: det.isVariable,
      frequency: toBillFrequency(det.frequency),
      occurrenceCount: det.occurrenceCount,
      firstSeen: det.firstSeen,
      lastSeen: det.lastSeen,
      nextExpectedDate: det.nextExpectedDate,
      dueDay: dueDayFrom(det),
      confidence: parseFloat(String(det.confidence)),
      status: det.status,
      duplicateOf: det.duplicateOf,
      duplicateBillName: det.duplicateOf != null ? (dupNameById.get(det.duplicateOf) ?? null) : null,
      suggestedCategory: suggestCategoryFromSamples(txns),
      paymentAccountId: account?.id ?? null,
      paymentAccountName: account?.name ?? null,
      sampleTransactions: evidence,
    };
  });

  res.json(ListDetectedBillDraftsResponse.parse(drafts));
});

router.post("/bills/detected/:id/confirm", async (req, res): Promise<void> => {
  const { id } = ConfirmDetectedBillParams.parse(req.params);
  const overrides = ConfirmDetectedBillBody.safeParse(req.body ?? {});
  if (!overrides.success) {
    res.status(400).json({ error: overrides.error.message });
    return;
  }
  const ov = overrides.data;
  const [det] = await db
    .select()
    .from(detectedBillsTable)
    .where(and(eq(detectedBillsTable.id, id), eq(detectedBillsTable.userId, req.userId)));
  if (!det) {
    res.status(404).json({ error: "Detected bill not found" });
    return;
  }
  if (det.status === "confirmed" || det.status === "dismissed") {
    res.status(409).json({ error: `Already ${det.status}` });
    return;
  }
  if (det.status === "duplicate") {
    res.status(409).json({ error: "Already tracked by an existing bill — dismiss this detection instead" });
    return;
  }

  const txns = await loadSampleTxns(req.userId, sampleTxnIdsOf(det));

  // Paying account: explicit override wins (null = deliberately unlinked);
  // otherwise the dominant account among the detection's sample charges.
  let paymentAccountId: number | null;
  if (ov.paymentAccountId !== undefined) {
    if (!(await paymentAccountBelongsToUser(req.userId, ov.paymentAccountId))) {
      res.status(400).json({ error: "Invalid paying account" });
      return;
    }
    paymentAccountId = ov.paymentAccountId;
  } else {
    const plaidAccountId = dominantPlaidAccountId(txns);
    const [account] = plaidAccountId
      ? await db
          .select({ id: accountsTable.id })
          .from(accountsTable)
          .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidAccountId, plaidAccountId)))
      : [];
    paymentAccountId = account?.id ?? null;
  }

  // Match merchant: explicit override wins (null clears); default to the
  // detection's BASE merchant key (sibling amount suffix stripped) so the
  // bill is pre-linked from day one — sibling bills share the merchant
  // pattern and are disambiguated by amount/date at matching time.
  const matchMerchant =
    ov.matchMerchant !== undefined
      ? normalizeMatchMerchant(ov.matchMerchant)
      : (normalizeMatchMerchant(baseMerchantKey(det.merchantKey)) ?? null);

  const category = ov.category ?? suggestCategoryFromSamples(txns);
  const dueDay = ov.dueDay ?? dueDayFrom(det);

  const bill = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(billsTable)
      .values({
        userId: req.userId,
        billName: ov.billName ?? det.displayName,
        category,
        amount: String(ov.amount ?? det.amount),
        frequency: ov.frequency ?? toBillFrequency(det.frequency),
        dueDay,
        paymentAccountId,
        matchMerchant: matchMerchant ?? null,
        isVariable: det.isVariable,
        isActive: true,
        notes: "Auto-detected from transactions",
        startDate: det.nextExpectedDate,
      })
      .returning();
    await tx
      .update(detectedBillsTable)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(detectedBillsTable.id, id));
    return created;
  });
  // Real-time cycle sync (same semantics as POST /bills): the confirmed bill
  // must appear in its card's open cycles immediately and reconcile its
  // charges out of Misc. A sync failure is surfaced, not swallowed — the
  // bill IS saved and the detection IS confirmed.
  if (bill!.paymentAccountId != null) {
    try {
      const sync = await syncBillWithCycles({ userId: req.userId, billId: bill!.id });
      req.log.info({ sync }, "bill-cycle sync after detected-bill confirm");
    } catch (err) {
      req.log.error({ err }, "bill-cycle sync failed after detected-bill confirm");
      res.status(503).json({
        error: "Bill was created, but updating its card cycles failed. Refresh — do not re-confirm.",
        billId: bill!.id,
      });
      return;
    }
  }
  req.log.info({ detectedBillId: id, billId: bill!.id }, "Detected bill confirmed and bill created");
  res.json(
    ConfirmDetectedBillResponse.parse({
      ...bill!,
      amount: parseFloat(String(bill!.amount)),
      amountType: bill!.amountType,
      createdAt: bill!.createdAt.toISOString(),
      updatedAt: bill!.updatedAt.toISOString(),
    }),
  );
});

router.post("/bills/detected/:id/dismiss", async (req, res): Promise<void> => {
  const { id } = DismissDetectedBillParams.parse(req.params);
  const [det] = await db
    .update(detectedBillsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(eq(detectedBillsTable.id, id), eq(detectedBillsTable.userId, req.userId)))
    .returning();
  if (!det) {
    res.status(404).json({ error: "Detected bill not found" });
    return;
  }
  req.log.info({ detectedBillId: id }, "Detected bill dismissed");
  res.json(DismissDetectedBillResponse.parse(serializeDetected(det)));
});

export default router;
