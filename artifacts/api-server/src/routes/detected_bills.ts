import { Router, type IRouter } from "express";
import { and, eq, inArray, desc } from "drizzle-orm";
import { db, detectedBillsTable, billsTable, plaidTransactionsTable, type DetectedBill } from "@workspace/db";
import {
  DetectBillsResponse,
  ListDetectedBillsResponse,
  ConfirmDetectedBillParams,
  ConfirmDetectedBillResponse,
  DismissDetectedBillParams,
  DismissDetectedBillResponse,
  suggestCategoryFromPlaid,
} from "@workspace/api-zod";
import { detectBills } from "../services/bill-detection";

const router: IRouter = Router();

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

router.post("/bills/detected/:id/confirm", async (req, res): Promise<void> => {
  const { id } = ConfirmDetectedBillParams.parse(req.params);
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
  // Pre-fill the category from the Plaid personal_finance_category of the
  // detected bill's sample transactions (most common primary wins). This is a
  // suggestion only — the user can edit the created bill's category anytime.
  let suggestedCategory = "Other";
  const sampleTxnIds = Array.isArray(det.sampleTxnIds) ? (det.sampleTxnIds as string[]) : [];
  if (sampleTxnIds.length > 0) {
    const txns = await db
      .select({
        primary: plaidTransactionsTable.personalFinanceCategory,
        detailed: plaidTransactionsTable.personalFinanceCategoryDetailed,
      })
      .from(plaidTransactionsTable)
      .where(
        and(
          eq(plaidTransactionsTable.userId, req.userId),
          inArray(plaidTransactionsTable.plaidTransactionId, sampleTxnIds),
        ),
      );
    // Deterministic aggregation: most-common primary wins; ties break
    // lexicographically. For the winning primary, the most-common detailed
    // value wins (same tie-break) before applying the override mapping.
    const primaryCounts = new Map<string, number>();
    for (const t of txns) {
      if (!t.primary) continue;
      primaryCounts.set(t.primary, (primaryCounts.get(t.primary) ?? 0) + 1);
    }
    const bestPrimary = [...primaryCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    if (bestPrimary) {
      const detailedCounts = new Map<string, number>();
      for (const t of txns) {
        if (t.primary !== bestPrimary || !t.detailed) continue;
        detailedCounts.set(t.detailed, (detailedCounts.get(t.detailed) ?? 0) + 1);
      }
      const bestDetailed =
        [...detailedCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
        null;
      suggestedCategory = suggestCategoryFromPlaid(bestPrimary, bestDetailed);
    }
  }
  const dueDaySource = det.nextExpectedDate ?? det.lastSeen;
  const parsedDay = dueDaySource ? Number(dueDaySource.slice(8, 10)) : NaN;
  const dueDay = Number.isInteger(parsedDay) && parsedDay >= 1 && parsedDay <= 31 ? parsedDay : 1;
  const bill = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(billsTable)
      .values({
        userId: req.userId,
        billName: det.displayName,
        category: suggestedCategory,
        amount: String(det.amount),
        frequency: det.frequency,
        dueDay,
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
