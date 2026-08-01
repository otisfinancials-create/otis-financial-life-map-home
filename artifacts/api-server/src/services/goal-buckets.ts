import {
  db,
  goalsTable,
  billsTable,
  forecastedTransactionsTable,
  type Goal,
  type Bill,
} from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Bucket ledger (Decisions Addendum §2a) — the ONE place bucket arithmetic
 * lives. Routes and the forecast generator both call these helpers; never
 * re-derive bucket math elsewhere.
 *
 * ACTUAL bucket   = alreadySaved + Σ actualized contributions − withdrawals.
 *   "Actualized" = the contribution row is isActual (reconciled to a posted
 *   transfer OR explicitly marked paid). A row resolved "didn't happen"
 *   (status='removed', isActual=false) never counts — the money never moved.
 * PROJECTED bucket at the spend date = ACTUAL bucket + contributions still
 *   scheduled in the future (date > today, ≤ spend date). Past occurrences
 *   count only through what actually posted — a missed transfer therefore
 *   lowers the projection ("you missed two transfers, you'll be $X short"),
 *   while future ones are still assumed to happen so a future purchase can
 *   fund (Addendum §2b: netting stays on the schedule, never on actuals
 *   alone).
 */
export type BucketBreakdown = {
  alreadySaved: number;
  reconciledSum: number;
  withdrawals: number;
  derived: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function deriveActualBucket(userId: string, goal: Goal): Promise<BucketBreakdown> {
  const alreadySaved = parseFloat(String(goal.alreadySaved));

  let reconciledSum = 0;
  if (goal.billId != null) {
    const rows = await db
      .select({ amount: forecastedTransactionsTable.amount })
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.userId, userId),
        eq(forecastedTransactionsTable.sourceBillId, goal.billId),
        eq(forecastedTransactionsTable.isActual, true),
      ));
    reconciledSum = rows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);
  }

  // Withdrawals: actualized funding legs (money pulled back out of the bucket).
  const withdrawalRows = await db
    .select({ amount: forecastedTransactionsTable.amount })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.sourceGoalId, goal.id),
      eq(forecastedTransactionsTable.transactionType, "income"),
      eq(forecastedTransactionsTable.isActual, true),
    ));
  const withdrawals = withdrawalRows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);

  return {
    alreadySaved,
    reconciledSum: r2(reconciledSum),
    withdrawals: r2(withdrawals),
    derived: r2(alreadySaved + reconciledSum - withdrawals),
  };
}

/**
 * PROJECTED bucket at the spend date, reflecting reality (§3c):
 *   actual bucket + contribution × (scheduled occurrences with
 *   today < date ≤ spendDate).
 * `occurrenceDates` must come from generateBillOccurrences for the goal's
 * bill terms — same walk as the forecast emitter, never independent month
 * math.
 */
export function projectedAtSpendDate(
  actualBucket: number,
  contribution: number,
  occurrenceDates: string[],
  todayIso: string,
  spendDateIso: string,
): number {
  const future = occurrenceDates.filter((d) => d > todayIso && d <= spendDateIso).length;
  return r2(actualBucket + contribution * future);
}

/**
 * Recompute + persist goals.actual_bucket for every goal of the user that
 * carries (or carried) a contribution bill. Called after any event that can
 * actualize or un-actualize contribution rows (reconcile, unreconcile,
 * mark-paid, didn't-happen, auto-reconcile in the actuals roll). The stored
 * value exists so drift is DETECTABLE — computeBuckets exposes
 * stored-vs-derived on every read; this keeps stored honest at the source.
 */
export async function recomputeGoalActualBuckets(userId: string): Promise<void> {
  const goals = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.userId, userId), isNotNull(goalsTable.billId)));
  // Goals whose bill was detached (uncommit) keep alreadySaved as their bucket
  // via the uncommit path itself; only bill-carrying goals need recomputing.
  for (const goal of goals) {
    const { derived } = await deriveActualBucket(userId, goal);
    const stored = parseFloat(String(goal.actualBucket));
    if (Math.abs(stored - derived) >= 0.005) {
      await db
        .update(goalsTable)
        .set({ actualBucket: String(derived) })
        .where(and(eq(goalsTable.id, goal.id), eq(goalsTable.userId, userId)));
      logger.info({ userId, goalId: goal.id, stored, derived }, "Goal actual bucket recomputed");
    }
  }
}

/** Contribution bills for a user's goals, keyed by bill id (for the transfer
 * match class + roll integration). */
export async function goalContributionBillIds(userId: string): Promise<Set<number>> {
  const rows = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(and(eq(billsTable.userId, userId), eq(billsTable.billKind, "goal_contribution")));
  return new Set(rows.map((r) => r.id));
}

export type GoalBillLink = { goal: Goal; bill: Bill };

/** Committed-style goals joined to their live contribution bills. */
export async function goalsWithBills(userId: string): Promise<GoalBillLink[]> {
  const goals = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.userId, userId), isNotNull(goalsTable.billId)));
  if (goals.length === 0) return [];
  const bills = await db
    .select()
    .from(billsTable)
    .where(and(
      eq(billsTable.userId, userId),
      inArray(billsTable.id, goals.map((g) => g.billId!)),
    ));
  const byId = new Map(bills.map((b) => [b.id, b]));
  return goals
    .filter((g) => byId.has(g.billId!))
    .map((g) => ({ goal: g, bill: byId.get(g.billId!)! }));
}
