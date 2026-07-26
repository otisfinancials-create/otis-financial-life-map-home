import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  billsTable,
  forecastedTransactionsTable,
  accountsTable,
  cardCycleBillsTable,
  envelopeAllocationsTable,
  plaidTransactionsTable,
} from "@workspace/db";
import { syncBillWithCycles, detachBillFromAllCycles, refreshClosedCycles } from "../services/bill-cycle-sync";
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

/**
 * Normalize a user-supplied match merchant the same way the matcher
 * normalizes transaction names, so stored keys and match-time keys line up.
 * Empty/whitespace-only input clears the link (null).
 */
function normalizeMatchMerchant(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined; // not part of this request
  if (raw === null) return null;
  const norm = raw.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return norm || null;
}

/** Reject paymentAccountId values that don't belong to the requesting user. */
async function paymentAccountBelongsToUser(userId: string, paymentAccountId: number | null | undefined): Promise<boolean> {
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
  if (!(await paymentAccountBelongsToUser(req.userId, data.paymentAccountId))) {
    res.status(400).json({ error: "Invalid paying account" });
    return;
  }
  const [bill] = await db.insert(billsTable).values({
    ...data,
    matchMerchant: normalizeMatchMerchant(data.matchMerchant),
    userId: req.userId,
    amount: String(data.amount),
    isVariable: data.isVariable ?? false,
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
  const { amount: rawBillAmount, matchMerchant: rawMatchMerchant, ...restBillData } = canonicalized;
  const matchMerchant = normalizeMatchMerchant(rawMatchMerchant);
  // Capture the pre-update paying account so a moved bill leaves the old
  // card's cycles as part of the sync.
  const [before] = await db
    .select({ paymentAccountId: billsTable.paymentAccountId })
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
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
