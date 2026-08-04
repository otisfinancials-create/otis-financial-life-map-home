import { eq, sql, and, gte, inArray, isNotNull, gt } from "drizzle-orm";
import {
  db,
  accountsTable,
  cardCyclesTable,
  envelopesTable,
  cardCycleBillsTable,
  envelopeAllocationsTable,
  forecastedTransactionsTable,
  type CardCycle,
} from "@workspace/db";
import { populateNewCycle } from "./envelopes";

/** Last valid day of a month (monthIndex 0-11). */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** YYYY-MM-DD for (year, monthIndex, day) with the day clamped to the month. */
function clampedIso(year: number, monthIndex: number, day: number): string {
  // Normalize month overflow (e.g. monthIndex 13 → next year Feb).
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * Delete a cycle and everything hanging off it: allocations targeting its
 * envelopes or cycle-bills, the envelopes and cycle-bills themselves, and any
 * forecast payment rows generated from it.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Core dependent-row cleanup, usable inside an enclosing transaction. */
export async function deleteCycleWithDependentsTx(tx: Executor, cycleId: number): Promise<void> {
  const envIds = (
    await tx.select({ id: envelopesTable.id }).from(envelopesTable).where(eq(envelopesTable.cardCycleId, cycleId))
  ).map((e) => e.id);
  const ccbIds = (
    await tx.select({ id: cardCycleBillsTable.id }).from(cardCycleBillsTable).where(eq(cardCycleBillsTable.cardCycleId, cycleId))
  ).map((b) => b.id);
  if (envIds.length) await tx.delete(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.envelopeId, envIds));
  if (ccbIds.length) await tx.delete(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.cardCycleBillId, ccbIds));
  await tx.delete(envelopesTable).where(eq(envelopesTable.cardCycleId, cycleId));
  await tx.delete(cardCycleBillsTable).where(eq(cardCycleBillsTable.cardCycleId, cycleId));
  await tx.delete(forecastedTransactionsTable).where(eq(forecastedTransactionsTable.sourceCardCycleId, cycleId));
  await tx.delete(cardCyclesTable).where(eq(cardCyclesTable.id, cycleId));
}

export async function deleteCycleWithDependents(cycleId: number): Promise<void> {
  await db.transaction(async (tx) => deleteCycleWithDependentsTx(tx, cycleId));
}

/**
 * Generate the current cycle plus the next 3 (4 total) for a card, based on
 * its statement_day (cycle_end) and due_day (payment due the month after the
 * statement closes).
 *
 * REPLACE semantics (config changes must not accumulate cycles):
 * - A cycle's identity is its PERIOD — the YYYY-MM its statement closes in —
 *   not its exact cycle_start. A window shifted by a day (07-15 vs 07-16) is
 *   the SAME period and must never coexist as two cycles.
 * - For each desired period, an existing cycle in that period is UPDATED to
 *   the new dates (preserving its envelopes, budgets, and posted activity).
 *   If several exist (legacy duplicates), the one with real activity or
 *   user-entered budgets is kept and the rest are deleted with dependents.
 * - Managed-range cycles (period >= first desired period) whose period is no
 *   longer generated are deleted; past/closed cycles are left untouched.
 *
 * Returns [] if the account has no statement_day/due_day configured.
 */
export async function generateCyclesForAccount(accountId: number): Promise<CardCycle[]> {
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account || account.statementDay == null || account.dueDay == null) return [];

  const { statementDay, dueDay, userId } = account;
  const today = todayIso();
  const now = new Date(today + "T00:00:00");

  // Find the first statement close (cycle_end) on/after today — that month's
  // statement day, or next month's if this month's close already passed.
  let endYear = now.getFullYear();
  let endMonth = now.getMonth();
  if (clampedIso(endYear, endMonth, statementDay) < today) endMonth += 1;

  // Horizon: cycles must cover the FULL forecast window, not a fixed count.
  // regenerateForecastForUser projects 12 months out (endDate = last day of
  // today's month + 11), so generate every cycle whose payment due date falls
  // on/before that horizon. A fixed count (previously 4) made card payments
  // silently vanish from the forecast past mid-December.
  const horizonEnd = clampedIso(now.getFullYear(), now.getMonth() + 11, 31);

  // Desired cycles, keyed by period (YYYY-MM of cycle_end).
  const desired: Array<{ period: string; cycleStart: string; cycleEnd: string; dueDate: string }> = [];
  for (let i = 0; i < 24; i++) {
    const m = endMonth + i;
    const cycleEnd = clampedIso(endYear, m, statementDay);
    // cycle_start = day after the previous month's statement close.
    const prevEnd = clampedIso(endYear, m - 1, statementDay);
    const startDate = new Date(prevEnd + "T00:00:00");
    startDate.setDate(startDate.getDate() + 1);
    const cycleStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    // due_date: the due_day in the month after cycle_end; never before it.
    let dueDate = clampedIso(endYear, m + 1, dueDay);
    if (dueDate <= cycleEnd) dueDate = clampedIso(endYear, m + 2, dueDay);
    // Always keep the current cycle; past it, stop once payments fall beyond
    // the forecast horizon (they'd never be emitted anyway).
    if (i > 0 && dueDate > horizonEnd) break;
    desired.push({ period: cycleEnd.slice(0, 7), cycleStart, cycleEnd, dueDate });
  }
  const firstPeriod = desired[0].period;
  const desiredByPeriod = new Map(desired.map((d) => [d.period, d]));

  // Existing cycles in the managed range, grouped by period.
  const existing = await db
    .select()
    .from(cardCyclesTable)
    .where(and(eq(cardCyclesTable.accountId, accountId), gte(cardCyclesTable.cycleEnd, `${firstPeriod}-01`)));

  // Rank duplicates: keep the cycle with posted activity or user-entered
  // envelope budgets; ties break toward the exact desired dates, then age.
  const cycleIds = existing.map((c) => c.id);
  const budgetedIds = new Set<number>();
  const activeIds = new Set<number>();
  if (cycleIds.length) {
    const budgeted = await db
      .select({ id: envelopesTable.cardCycleId })
      .from(envelopesTable)
      .where(and(inArray(envelopesTable.cardCycleId, cycleIds), gt(envelopesTable.plannedAmount, "0")));
    for (const b of budgeted) budgetedIds.add(b.id);
    const spent = await db
      .select({ id: envelopesTable.cardCycleId })
      .from(envelopesTable)
      .where(and(inArray(envelopesTable.cardCycleId, cycleIds), gt(envelopesTable.spentAmount, "0")));
    for (const s of spent) activeIds.add(s.id);
    const reconciled = await db
      .select({ id: cardCycleBillsTable.cardCycleId })
      .from(cardCycleBillsTable)
      .where(and(inArray(cardCycleBillsTable.cardCycleId, cycleIds), isNotNull(cardCycleBillsTable.actualAmount)));
    for (const r of reconciled) activeIds.add(r.id);
  }
  const byPeriod = new Map<string, CardCycle[]>();
  for (const c of existing) {
    const p = c.cycleEnd.slice(0, 7);
    byPeriod.set(p, [...(byPeriod.get(p) ?? []), c]);
  }

  // One transaction for the whole replacement: dupe deletions, keeper date
  // updates, stale-period deletions, and inserts. A mid-run failure must not
  // leave a partially replaced cycle set.
  const { results, insertedIds } = await db.transaction(async (tx) => {
    const results: CardCycle[] = [];
    const insertedIds = new Set<number>();
    for (const d of desired) {
      const candidates = (byPeriod.get(d.period) ?? []).sort((a, b) => {
        const score = (c: CardCycle) =>
          (activeIds.has(c.id) ? 4 : 0) +
          (budgetedIds.has(c.id) ? 2 : 0) +
          (c.cycleStart === d.cycleStart && c.cycleEnd === d.cycleEnd ? 1 : 0);
        return score(b) - score(a) || a.id - b.id;
      });
      const keeper = candidates[0];
      for (const dupe of candidates.slice(1)) await deleteCycleWithDependentsTx(tx, dupe.id);
      if (keeper) {
        const [row] = await tx
          .update(cardCyclesTable)
          .set({ cycleStart: d.cycleStart, cycleEnd: d.cycleEnd, dueDate: d.dueDate, updatedAt: sql`now()` })
          .where(eq(cardCyclesTable.id, keeper.id))
          .returning();
        results.push(row);
      } else {
        const [row] = await tx
          .insert(cardCyclesTable)
          .values({ userId, accountId, cycleStart: d.cycleStart, cycleEnd: d.cycleEnd, dueDate: d.dueDate })
          .returning();
        insertedIds.add(row.id);
        results.push(row);
      }
    }
    // Stale windows from an old config whose period is no longer generated.
    for (const c of existing) {
      if (!desiredByPeriod.has(c.cycleEnd.slice(0, 7)) && !results.some((r) => r.id === c.id)) {
        await deleteCycleWithDependentsTx(tx, c.id);
      }
    }
    return { results, insertedIds };
  });

  // Seed defaults + copy forward recurring envelopes for the NEW cycles only.
  // Runs after commit (populateNewCycle manages its own db access); a failure
  // here leaves a valid cycle without seeded envelopes, matching the previous
  // behavior.
  for (const row of results) {
    if (insertedIds.has(row.id)) await populateNewCycle(row);
  }

  // Run the full processing pipeline (populate bills → allocate → spent →
  // rollup) on every managed cycle. Bills confirmed BEFORE the card's cycles
  // were configured have no card_cycle_bills rows yet — syncBillWithCycles was
  // a no-op when they were created — so generation must pull them in. Covers
  // both orders: bill-then-cycle (here) and cycle-then-bill (bill-cycle-sync).
  // Dynamic import mirrors cycle-processing's own import of this module and
  // avoids a static circular dependency.
  const { processCycle } = await import("./cycle-processing");
  for (const row of results) {
    if (row.status === "open") await processCycle(row.id);
  }
  return results;
}
