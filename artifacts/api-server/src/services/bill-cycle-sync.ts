import { and, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  cardCyclesTable,
  cardCycleBillsTable,
  envelopesTable,
  envelopeAllocationsTable,
  billsTable,
} from "@workspace/db";
import { processCycle, recomputeEnvelopeSpent, rollupCycle, billOccurrencesInCycle } from "./cycle-processing";

/**
 * Real-time bill → card-cycle sync (P5.6).
 *
 * Whenever a bill is created, edited, deleted, or deactivated, the affected
 * card's OPEN cycles (current + already-generated future ones) must reflect
 * the change immediately — no manual reprocess. Because cycles are monthly
 * windows, a monthly bill has exactly one expected occurrence in every cycle
 * window, so "which cycles does this bill belong to" = every open/future
 * cycle of its paying card (the same mapping populateCycleBills uses).
 *
 * Two phases:
 *  1. MEMBERSHIP (single transaction): add/remove/keep this bill's
 *     card_cycle_bills rows across all affected open cycles atomically, so a
 *     mid-flight failure can never leave some cycles updated and others not.
 *  2. REPROCESS (idempotent, retry-safe): run the existing engine
 *     (populateCycleBills → allocate → spent → rollup) per affected cycle.
 *
 * Guards:
 * - A cycle-bill row that already has matched allocations (a reconciled
 *   actual charge) is never silently dropped. If its bill was merely
 *   deactivated or moved to another card, the row is left untouched and
 *   reported in `keptReconciled`. If the bill was DELETED (the row cannot
 *   survive the FK), the plan is detached but the actual is kept: its
 *   allocations move to the cycle's catch-all envelope, then the row goes.
 * - Only the bill's own card(s) are touched; other cards' cycles are never
 *   reprocessed.
 * - Idempotent: membership upserts on (card_cycle_id, bill_id).
 */

/** Any Drizzle executor — the root db or a transaction handle. */
type DbLike = Pick<typeof db, "select" | "insert" | "update" | "delete">;

export interface BillCycleSyncResult {
  /** Open cycles that were re-populated + reprocessed. */
  reprocessedCycleIds: number[];
  /** Cycle-bill rows kept despite the bill no longer belonging (reconciled). */
  keptReconciled: Array<{ cardCycleId: number; cardCycleBillId: number }>;
  /** Allocations moved to the catch-all because their bill was deleted. */
  detachedAllocations: number;
}

const todayIso = (): string => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

export async function syncBillWithCycles(opts: {
  userId: string;
  billId: number;
  /** Bill's payment_account_id BEFORE the change, when it changed or the bill was deleted. */
  previousAccountId?: number | null;
  /** True when the bill row has been (or is about to be) hard-deleted. */
  deleted?: boolean;
  /** Extra OPEN cycles to reprocess (e.g. cycles a hard delete detached rows
   * from that belong to neither the current nor the previous account). */
  extraCycleIds?: number[];
}): Promise<BillCycleSyncResult> {
  const { userId, billId, previousAccountId, deleted = false, extraCycleIds = [] } = opts;
  const result: BillCycleSyncResult = { reprocessedCycleIds: [], keptReconciled: [], detachedAllocations: 0 };

  const [bill] = deleted
    ? [undefined]
    : await db.select().from(billsTable).where(and(eq(billsTable.id, billId), eq(billsTable.userId, userId)));

  // Cards whose cycles could be affected: the bill's current paying account
  // and (on account change / delete) its previous one. Non-card accounts
  // simply have no cycles, so they fall out naturally.
  const accountIds = [...new Set([bill?.paymentAccountId, previousAccountId].filter((a): a is number => a != null))];
  if (accountIds.length === 0 && extraCycleIds.length === 0) return result;

  // Current + future cycles only: open status and not yet ended. Closed
  // cycles are historical and are handled separately on hard delete.
  const openCycles = accountIds.length
    ? await db
        .select()
        .from(cardCyclesTable)
        .where(and(
          eq(cardCyclesTable.userId, userId),
          inArray(cardCyclesTable.accountId, accountIds),
          eq(cardCyclesTable.status, "open"),
          gte(cardCyclesTable.cycleEnd, todayIso()),
        ))
    : [];
  const missingExtra = extraCycleIds.filter((id) => !openCycles.some((c) => c.id === id));
  if (missingExtra.length) {
    openCycles.push(...await db
      .select()
      .from(cardCyclesTable)
      .where(and(
        eq(cardCyclesTable.userId, userId),
        inArray(cardCyclesTable.id, missingExtra),
        eq(cardCyclesTable.status, "open"),
      )));
  }
  if (openCycles.length === 0) return result;

  // ---- Phase 1: membership, atomic across every affected cycle. ----------
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(cardCycleBillsTable)
      .where(and(
        eq(cardCycleBillsTable.billId, billId),
        inArray(cardCycleBillsTable.cardCycleId, openCycles.map((c) => c.id)),
      ));
    const rowByCycle = new Map(rows.map((r) => [r.cardCycleId, r]));
    // Batch: which of this bill's rows have allocations (reconciled)?
    const allocRows = rows.length
      ? await tx
          .select({ id: envelopeAllocationsTable.id, cardCycleBillId: envelopeAllocationsTable.cardCycleBillId })
          .from(envelopeAllocationsTable)
          .where(inArray(envelopeAllocationsTable.cardCycleBillId, rows.map((r) => r.id)))
      : [];
    const reconciledRowIds = new Set(allocRows.map((a) => a.cardCycleBillId));

    for (const cycle of openCycles) {
      // Occurrence-based membership: the bill must be actively paid from
      // this card AND have at least one due date inside the cycle window
      // (same rule populateCycleBills applies in phase 2 — keep in lockstep).
      const belongs =
        !deleted &&
        !!bill &&
        bill.isActive === true &&
        bill.paymentAccountId === cycle.accountId &&
        billOccurrencesInCycle(bill, cycle.cycleStart, cycle.cycleEnd) > 0;
      const row = rowByCycle.get(cycle.id);
      if (belongs) continue; // membership added/refreshed by populateCycleBills in phase 2
      if (!row) continue;
      if (!reconciledRowIds.has(row.id)) {
        await tx.delete(cardCycleBillsTable).where(eq(cardCycleBillsTable.id, row.id));
      } else if (deleted) {
        result.detachedAllocations += await detachRowKeepActuals(tx, cycle.id, row.id);
      } else {
        // Reconciled history: keep the row, flag it for the caller.
        result.keptReconciled.push({ cardCycleId: cycle.id, cardCycleBillId: row.id });
      }
    }
  });

  // ---- Phase 2: reprocess with the existing engine (idempotent). ---------
  for (const cycle of openCycles) {
    await processCycle(cycle.id);
    result.reprocessedCycleIds.push(cycle.id);
  }

  return result;
}

/**
 * Hard-delete prep, run INSIDE the bill-delete transaction:
 * card_cycle_bills.bill_id has NO cascade, so every row referencing the bill
 * (open, closed, or past cycles alike) must be removed before the bill row
 * can be deleted. Reconciled actuals are preserved by moving their
 * allocations to the cycle's catch-all envelope ("keep the actual, detach
 * the plan"). Returns which cycles then need refreshing AFTER the
 * transaction commits: closed ones via refreshClosedCycles, open ones via
 * syncBillWithCycles({ extraCycleIds }) — removing even a pending row
 * changes the cycle's planned_total.
 */
export async function detachBillFromAllCycles(
  tx: DbLike,
  userId: string,
  billId: number,
): Promise<{ detachedAllocations: number; closedCyclesToRecompute: number[]; openCyclesToReprocess: number[] }> {
  const rows = await tx
    .select({ row: cardCycleBillsTable, cycleStatus: cardCyclesTable.status })
    .from(cardCycleBillsTable)
    .innerJoin(cardCyclesTable, eq(cardCycleBillsTable.cardCycleId, cardCyclesTable.id))
    .where(and(eq(cardCycleBillsTable.billId, billId), eq(cardCycleBillsTable.userId, userId)));

  let detachedAllocations = 0;
  const closedCyclesToRecompute = new Set<number>();
  const openCyclesToReprocess = new Set<number>();
  for (const { row, cycleStatus } of rows) {
    detachedAllocations += await detachRowKeepActuals(tx, row.cardCycleId, row.id);
    // Any removed row changes the cycle's planned_total (and possibly its
    // envelope spent when allocations moved), so every touched cycle needs
    // a refresh — not just those with reconciled allocations.
    if (cycleStatus === "open") openCyclesToReprocess.add(row.cardCycleId);
    else closedCyclesToRecompute.add(row.cardCycleId);
  }
  return {
    detachedAllocations,
    closedCyclesToRecompute: [...closedCyclesToRecompute],
    openCyclesToReprocess: [...openCyclesToReprocess],
  };
}

/** Closed cycles are not reprocessed by syncBillWithCycles — refresh their
 * envelope spent + rollup so accumulated/planned totals stay honest. */
export async function refreshClosedCycles(cycleIds: number[]): Promise<void> {
  for (const cycleId of cycleIds) {
    await recomputeEnvelopeSpent(cycleId);
    await rollupCycle(cycleId);
  }
}

/** Move a cycle-bill row's allocations to the cycle's catch-all envelope and
 * delete the row. Returns how many allocations were moved. */
async function detachRowKeepActuals(tx: DbLike, cardCycleId: number, cardCycleBillId: number): Promise<number> {
  const allocs = await tx
    .select({ id: envelopeAllocationsTable.id })
    .from(envelopeAllocationsTable)
    .where(eq(envelopeAllocationsTable.cardCycleBillId, cardCycleBillId));

  if (allocs.length > 0) {
    const [catchall] = await tx
      .select()
      .from(envelopesTable)
      .where(and(eq(envelopesTable.cardCycleId, cardCycleId), eq(envelopesTable.isCatchall, true)));
    if (!catchall) {
      // Never orphan a reconciled actual (the XOR check constraint would
      // reject a target-less allocation anyway). Without a catch-all we
      // cannot preserve it, so refuse the detach.
      throw new Error(`Cycle ${cardCycleId} has no catch-all envelope; cannot detach reconciled bill allocations`);
    }
    await tx
      .update(envelopeAllocationsTable)
      .set({ envelopeId: catchall.id, cardCycleBillId: null })
      .where(inArray(envelopeAllocationsTable.id, allocs.map((a) => a.id)));
  }
  await tx.delete(cardCycleBillsTable).where(eq(cardCycleBillsTable.id, cardCycleBillId));
  return allocs.length;
}
