import { and, eq, lt, desc } from "drizzle-orm";
import { db, cardCyclesTable, envelopesTable, type CardCycle, type Envelope } from "@workspace/db";

/** Number of Mondays between two YYYY-MM-DD dates, inclusive. */
export function mondaysInRange(startIso: string, endIso: string): number {
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  if (end < start) return 0;
  // Advance to the first Monday on/after start (getDay(): 0=Sun, 1=Mon).
  const first = new Date(start);
  first.setDate(first.getDate() + ((8 - first.getDay()) % 7));
  if (first > end) return 0;
  return Math.floor((end.getTime() - first.getTime()) / (7 * 86400000)) + 1;
}

/** planned_amount for a food envelope: Mondays in cycle × weekly rate. */
export function foodPlannedAmount(cycle: Pick<CardCycle, "cycleStart" | "cycleEnd">, weeklyRate: number): number {
  return mondaysInRange(cycle.cycleStart, cycle.cycleEnd) * weeklyRate;
}

/**
 * Seed the default envelopes (Food / Gas / Misc catch-all) into a cycle.
 * Idempotent: a default is skipped when the cycle already has a matching
 * envelope (food type for Food, catch-all flag for Misc, name for Gas).
 */
export async function seedDefaultEnvelopes(cardCycleId: number): Promise<Envelope[]> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cardCycleId));
  if (!cycle) return [];
  const existing = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cardCycleId));

  const created: Envelope[] = [];
  const hasFood = existing.some((e) => e.envelopeType === "food");
  const hasGas = existing.some((e) => e.name.trim().toLowerCase() === "gas");
  const hasMisc = existing.some((e) => e.isCatchall);

  if (!hasFood) {
    const [row] = await db.insert(envelopesTable).values({
      userId: cycle.userId,
      cardCycleId,
      name: "Food",
      category: "Food",
      envelopeType: "food",
      cadence: "weekly",
      recurring: true,
      weeklyRate: "0",
      plannedAmount: "0", // mondays × 0
    }).onConflictDoNothing().returning();
    if (row) created.push(row);
  }
  if (!hasGas) {
    const [row] = await db.insert(envelopesTable).values({
      userId: cycle.userId,
      cardCycleId,
      name: "Gas",
      category: "Transportation",
      envelopeType: "standard",
      cadence: "one-time",
      recurring: true,
      plannedAmount: "0",
    }).onConflictDoNothing().returning();
    if (row) created.push(row);
  }
  if (!hasMisc) {
    const [row] = await db.insert(envelopesTable).values({
      userId: cycle.userId,
      cardCycleId,
      name: "Misc",
      category: "Miscellaneous",
      envelopeType: "standard",
      isCatchall: true,
      cadence: "one-time",
      recurring: true,
      plannedAmount: "0",
    }).onConflictDoNothing().returning();
    if (row) created.push(row);
  }
  return created;
}

/**
 * Copy recurring envelopes from the most recent prior cycle of the same
 * account into a newly created cycle, then seed any missing defaults.
 * Copy-forward runs first so a user's customized recurring envelopes (e.g.
 * food with a set weekly_rate) win over the zeroed defaults. Carryover and
 * single-cycle envelopes are never copied.
 */
export async function populateNewCycle(cycle: CardCycle): Promise<void> {
  const [prior] = await db
    .select()
    .from(cardCyclesTable)
    .where(and(
      eq(cardCyclesTable.accountId, cycle.accountId),
      lt(cardCyclesTable.cycleStart, cycle.cycleStart),
    ))
    .orderBy(desc(cardCyclesTable.cycleStart))
    .limit(1);

  if (prior) {
    const priorEnvelopes = await db
      .select()
      .from(envelopesTable)
      .where(eq(envelopesTable.cardCycleId, prior.id));
    const existing = await db
      .select()
      .from(envelopesTable)
      .where(eq(envelopesTable.cardCycleId, cycle.id));
    const existingNames = new Set(existing.map((e) => e.name.trim().toLowerCase()));

    for (const env of priorEnvelopes) {
      if (!env.recurring || env.isCarryover) continue;
      if (existingNames.has(env.name.trim().toLowerCase())) continue;
      const rate = env.weeklyRate != null ? parseFloat(String(env.weeklyRate)) : null;
      const planned = env.envelopeType === "food" && rate != null
        ? String(foodPlannedAmount(cycle, rate))
        : env.plannedAmount;
      await db.insert(envelopesTable).values({
        userId: env.userId,
        cardCycleId: cycle.id,
        // (unique constraint on (card_cycle_id, name) makes this race-safe)
        name: env.name,
        category: env.category,
        plannedAmount: planned,
        cadence: env.cadence,
        note: env.note,
        envelopeType: env.envelopeType,
        isCatchall: env.isCatchall,
        recurring: true,
        weeklyRate: env.weeklyRate,
      }).onConflictDoNothing();
      existingNames.add(env.name.trim().toLowerCase());
    }
  }

  await seedDefaultEnvelopes(cycle.id);
}
