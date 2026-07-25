import { eq, sql } from "drizzle-orm";
import { db, accountsTable, cardCyclesTable, type CardCycle } from "@workspace/db";

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
 * Generate the current cycle plus the next 3 (4 total) for a card, based on
 * its statement_day (cycle_end) and due_day (payment due the month after the
 * statement closes). Idempotent: upserts on (account_id, cycle_start).
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

  const results: CardCycle[] = [];
  for (let i = 0; i < 4; i++) {
    const m = endMonth + i;
    const cycleEnd = clampedIso(endYear, m, statementDay);
    // cycle_start = day after the previous month's statement close.
    const prevEnd = clampedIso(endYear, m - 1, statementDay);
    const startDate = new Date(prevEnd + "T00:00:00");
    startDate.setDate(startDate.getDate() + 1);
    const cycleStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    // due_date: the due_day in the month after cycle_end; if that still lands
    // on/before cycle_end (impossible for +1 month with day<=31, but keep the
    // invariant explicit), push another month. Never before cycle_end.
    let dueDate = clampedIso(endYear, m + 1, dueDay);
    if (dueDate <= cycleEnd) dueDate = clampedIso(endYear, m + 2, dueDay);

    const [row] = await db
      .insert(cardCyclesTable)
      .values({ userId, accountId, cycleStart, cycleEnd, dueDate })
      .onConflictDoUpdate({
        target: [cardCyclesTable.accountId, cardCyclesTable.cycleStart],
        set: { cycleEnd, dueDate, updatedAt: sql`now()` },
      })
      .returning();
    results.push(row);
  }
  return results;
}
