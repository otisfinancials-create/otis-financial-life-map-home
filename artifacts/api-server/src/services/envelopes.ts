import { and, eq, lt, gt, desc, asc } from "drizzle-orm";
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
      matchCategories: ["FOOD_AND_DRINK_GROCERIES"], // groceries only; dining falls to Misc
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
      matchCategories: ["TRANSPORTATION_GAS"], // fuel only; transit/parking fall to Misc
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
    // The recurring DEFAULT for each envelope name is the most recent prior
    // NON-OVERRIDDEN row: a per-cycle override applies to its cycle only and
    // must never leak into newly generated cycles. Scan all prior cycles
    // (newest first) so an override in the immediately-previous cycle falls
    // through to the last recurring default behind it.
    const priorRows = await db
      .select({ env: envelopesTable })
      .from(envelopesTable)
      .innerJoin(cardCyclesTable, eq(envelopesTable.cardCycleId, cardCyclesTable.id))
      .where(and(
        eq(cardCyclesTable.accountId, cycle.accountId),
        lt(cardCyclesTable.cycleStart, cycle.cycleStart),
      ))
      .orderBy(desc(cardCyclesTable.cycleStart));
    const byName = new Map<string, Envelope>();
    for (const { env } of priorRows) {
      const key = env.name.trim().toLowerCase();
      const current = byName.get(key);
      // Prefer the newest non-override; keep the newest override only as a
      // fallback when every prior occurrence is an override.
      if (!current) byName.set(key, env);
      else if (current.isOverride && !env.isOverride) byName.set(key, env);
    }
    const priorEnvelopes = [...byName.values()];
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
        matchCategories: env.matchCategories,
      }).onConflictDoNothing();
      existingNames.add(env.name.trim().toLowerCase());
    }
  }

  await seedDefaultEnvelopes(cycle.id);
}

/**
 * Propagate a recurring envelope's amount forward: update the same-named
 * envelope in every FUTURE cycle of the same account that has not been
 * individually overridden (is_override = false). Food envelopes propagate the
 * weekly rate and recompute planned_amount per cycle (Mondays × rate); other
 * types copy planned_amount as-is. Carryover envelopes are never touched.
 * Returns the ids of every cycle whose planned total changed (callers must
 * refresh rollups + the forecast).
 */
export async function propagateRecurringAmount(source: Envelope): Promise<number[]> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, source.cardCycleId));
  if (!cycle) return [];
  const futureCycles = await db
    .select()
    .from(cardCyclesTable)
    .where(and(
      eq(cardCyclesTable.accountId, cycle.accountId),
      gt(cardCyclesTable.cycleStart, cycle.cycleStart),
    ))
    .orderBy(asc(cardCyclesTable.cycleStart));
  if (futureCycles.length === 0) return [];

  const rate = source.weeklyRate != null ? parseFloat(String(source.weeklyRate)) : null;
  const key = source.name.trim().toLowerCase();
  const touched: number[] = [];
  for (const fc of futureCycles) {
    const rows = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, fc.id));
    const target = rows.find((e) => !e.isCarryover && e.name.trim().toLowerCase() === key);
    if (!target || target.isOverride) continue;
    const planned = source.envelopeType === "food" && rate != null
      ? String(foodPlannedAmount(fc, rate))
      : String(source.plannedAmount ?? "0");
    if (String(target.plannedAmount) === planned && String(target.weeklyRate) === String(source.weeklyRate)) continue;
    await db
      .update(envelopesTable)
      .set({ plannedAmount: planned, weeklyRate: source.weeklyRate, updatedAt: new Date() })
      .where(eq(envelopesTable.id, target.id));
    touched.push(fc.id);
  }
  return touched;
}
