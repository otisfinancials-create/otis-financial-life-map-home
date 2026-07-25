import { and, eq, gt, gte, lte, inArray } from "drizzle-orm";
import {
  db,
  cardCyclesTable,
  cardCycleBillsTable,
  envelopesTable,
  envelopeAllocationsTable,
  billsTable,
  accountsTable,
  plaidTransactionsTable,
  type CardCycle,
  type Envelope,
  type CardCycleBill,
  type PlaidTransaction,
} from "@workspace/db";

/**
 * P5 Stage 3a — the core cycle engine: bill population, transaction
 * allocation, envelope spent recompute, and cycle rollup.
 * No carryover generation (Stage 3b) and no forecast/UI changes here.
 */

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : parseFloat(v) || 0;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ---------------------------------------------------------------- STEP 1 */

/**
 * Upsert a card_cycle_bills row for every active bill paid from the cycle's
 * card. Idempotent on (card_cycle_id, bill_id).
 */
export async function populateCycleBills(cardCycleId: number): Promise<CardCycleBill[]> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cardCycleId));
  if (!cycle) return [];

  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.paymentAccountId, cycle.accountId), eq(billsTable.isActive, true)));

  for (const bill of bills) {
    await db
      .insert(cardCycleBillsTable)
      .values({
        userId: cycle.userId,
        cardCycleId,
        billId: bill.id,
        expectedAmount: String(bill.amount),
        actualAmount: null,
        status: "pending",
      })
      .onConflictDoNothing();
  }

  return db.select().from(cardCycleBillsTable).where(eq(cardCycleBillsTable.cardCycleId, cardCycleId));
}

/* ---------------------------------------------------------------- STEP 2 */

/** Lowercase, strip everything but letters/digits/spaces, collapse spaces. */
function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(["the", "and", "for", "inc", "llc", "co", "of", "a"]);

function tokens(s: string | null | undefined): string[] {
  return normalize(s).split(" ").filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Merchant/name similarity: any significant token shared between the bill
 * name and the transaction's name or merchant_name. */
function namesSimilar(bill: { billName: string }, txn: PlaidTransaction): boolean {
  const billTokens = tokens(bill.billName);
  if (billTokens.length === 0) return false;
  const txnTokens = new Set([...tokens(txn.name), ...tokens(txn.merchantName)]);
  return billTokens.some((t) => txnTokens.has(t));
}

/** Free-text fallback match: normalized equality or containment either way,
 * e.g. envelope "Food" matches Plaid primary "FOOD_AND_DRINK". */
function categoryMatches(envelopeCategory: string | null, plaidCategory: string | null): boolean {
  const e = normalize(envelopeCategory).replace(/ /g, "");
  const p = normalize(plaidCategory).replace(/ /g, "");
  if (!e || !p) return false;
  return e === p || e.includes(p) || p.includes(e);
}

/**
 * Named-envelope match. When the envelope declares match_categories (Plaid
 * DETAILED codes, e.g. TRANSPORTATION_GAS), the charge's detailed category
 * must be in that list — precise, no containment. Otherwise fall back to the
 * legacy free-text match against the PRIMARY category.
 */
function envelopeMatches(env: Envelope, txn: PlaidTransaction): boolean {
  if (env.matchCategories && env.matchCategories.length > 0) {
    const detailed = (txn.personalFinanceCategoryDetailed ?? "").toUpperCase();
    return detailed !== "" && env.matchCategories.some((c) => c.toUpperCase() === detailed);
  }
  return categoryMatches(env.category, txn.personalFinanceCategory);
}

export interface AllocationSummary {
  transactionsAllocated: number;
  skippedManual: number;
}

/**
 * Allocate every posted charge in the cycle window to exactly one target:
 * matching cycle bill (name similarity + amount within ±15%), else a named
 * envelope by category, else the catch-all. Idempotent per transaction;
 * manual allocations are never overwritten.
 */
export async function allocateTransactionsForCycle(cardCycleId: number): Promise<AllocationSummary> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cardCycleId));
  if (!cycle) return { transactionsAllocated: 0, skippedManual: 0 };

  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, cycle.accountId));
  if (!account?.plaidAccountId) return { transactionsAllocated: 0, skippedManual: 0 };

  const txns = await db
    .select()
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.accountId, account.plaidAccountId),
      gt(plaidTransactionsTable.amount, "0"),
      eq(plaidTransactionsTable.pending, false),
      gte(plaidTransactionsTable.date, cycle.cycleStart),
      lte(plaidTransactionsTable.date, cycle.cycleEnd),
    ));

  const cycleBills = await db
    .select({ cycleBill: cardCycleBillsTable, billName: billsTable.billName })
    .from(cardCycleBillsTable)
    .innerJoin(billsTable, eq(cardCycleBillsTable.billId, billsTable.id))
    .where(eq(cardCycleBillsTable.cardCycleId, cardCycleId));

  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cardCycleId));
  const catchall = envelopes.find((e) => e.isCatchall);
  if (!catchall) {
    throw new Error(`Cycle ${cardCycleId} has no catch-all envelope; seed envelopes before processing`);
  }
  const named = envelopes.filter((e) => !e.isCatchall && !e.isCarryover);
  // Carryover envelopes (Stage 3b) drain FIRST for charges they match, up to
  // their planned_amount. Whole-charge assignment: a charge goes entirely to
  // the carryover while it still has room, else to the regular envelope.
  const carryovers = envelopes.filter((e) => e.isCarryover);

  // Reconcile stale auto allocations: any auto allocation pointing at this
  // cycle's envelopes/bills whose transaction is no longer a qualifying
  // posted in-window charge (became pending, moved out of window, refunded,
  // or was deleted) is removed so it can't inflate totals.
  const qualifyingIds = new Set(txns.map((t) => t.plaidTransactionId));
  const cycleTargetAllocs = [
    ...(envelopes.length
      ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.envelopeId, envelopes.map((e) => e.id)))
      : []),
    ...(cycleBills.length
      ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.cardCycleBillId, cycleBills.map((b) => b.cycleBill.id)))
      : []),
  ];
  const staleIds = cycleTargetAllocs
    .filter((a) => a.source === "auto" && (a.plaidTransactionId == null || !qualifyingIds.has(a.plaidTransactionId)))
    .map((a) => a.id);
  if (staleIds.length) {
    await db.delete(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.id, staleIds));
  }

  // Prefetch existing allocations for these transactions in one query.
  const txnIds = txns.map((t) => t.plaidTransactionId);
  const existing = txnIds.length
    ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.plaidTransactionId, txnIds))
    : [];
  const existingByTxn = new Map(existing.map((a) => [a.plaidTransactionId, a]));

  let allocated = 0;
  let skippedManual = 0;

  // Room left in each carryover envelope. Manual allocations already pinned
  // to a carryover consume its room up front (they are skipped in the loop
  // below but still occupy the budget).
  const carryoverRoom = new Map<number, number>();
  for (const co of carryovers) {
    const manualSpent = cycleTargetAllocs
      .filter((a) => a.envelopeId === co.id && a.source === "manual")
      .reduce((s, a) => s + num(a.amount), 0);
    carryoverRoom.set(co.id, num(co.plannedAmount) - manualSpent);
  }

  for (const txn of txns) {
    const prior = existingByTxn.get(txn.plaidTransactionId);
    if (prior?.source === "manual") {
      skippedManual += 1;
      continue;
    }

    // 1. Bill match: name similarity AND amount within ±15% of expected.
    //    Prefer the closest amount when several bills qualify.
    const amount = num(txn.amount);
    let bestBill: { id: number; relDiff: number } | undefined;
    for (const { cycleBill, billName } of cycleBills) {
      const expected = num(cycleBill.expectedAmount);
      if (expected <= 0) continue;
      const relDiff = Math.abs(amount - expected) / expected;
      if (relDiff <= 0.15 && namesSimilar({ billName }, txn)) {
        if (!bestBill || relDiff < bestBill.relDiff) bestBill = { id: cycleBill.id, relDiff };
      }
    }

    // 2. Carryover envelope (drains first, while it has room);
    // 3. named envelope by category; 4. catch-all.
    let envelopeId: number | null = null;
    let cardCycleBillId: number | null = null;
    if (bestBill) {
      cardCycleBillId = bestBill.id;
    } else {
      const carryover = carryovers.find(
        (e) => (carryoverRoom.get(e.id) ?? 0) > 0.005 && envelopeMatches(e, txn),
      );
      if (carryover) {
        envelopeId = carryover.id;
        carryoverRoom.set(carryover.id, (carryoverRoom.get(carryover.id) ?? 0) - amount);
      } else {
        const env = named.find((e) => envelopeMatches(e, txn));
        envelopeId = env ? env.id : catchall.id;
      }
    }

    await db
      .insert(envelopeAllocationsTable)
      .values({
        userId: cycle.userId,
        plaidTransactionId: txn.plaidTransactionId,
        envelopeId,
        cardCycleBillId,
        amount: String(amount),
        source: "auto",
      })
      .onConflictDoUpdate({
        target: envelopeAllocationsTable.plaidTransactionId,
        set: { envelopeId, cardCycleBillId, amount: String(amount) },
        // Never overwrite a manual allocation (double guard alongside the
        // prefetch check above, in case one was created concurrently).
        setWhere: eq(envelopeAllocationsTable.source, "auto"),
      });
    allocated += 1;
  }

  // Recompute each cycle bill's actual_amount and status from allocations
  // (a bill hit twice sums both charges; a bill whose allocations moved away
  // reverts to pending).
  for (const { cycleBill } of cycleBills) {
    const allocs = await db
      .select()
      .from(envelopeAllocationsTable)
      .where(eq(envelopeAllocationsTable.cardCycleBillId, cycleBill.id));
    const total = round2(allocs.reduce((s, a) => s + num(a.amount), 0));
    await db
      .update(cardCycleBillsTable)
      .set({
        actualAmount: allocs.length ? String(total) : null,
        status: allocs.length ? "hit" : "pending",
      })
      .where(eq(cardCycleBillsTable.id, cycleBill.id));
  }

  return { transactionsAllocated: allocated, skippedManual };
}

/* ---------------------------------------------------------------- STEP 3 */

/**
 * Recompute each envelope's spent_amount as the true SUM of its allocations.
 * Overspend is stored truthfully (never capped at planned); the max(0,
 * planned - spent) floor is display-only and derived by consumers.
 */
export async function recomputeEnvelopeSpent(cardCycleId: number): Promise<Envelope[]> {
  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cardCycleId));
  for (const env of envelopes) {
    const allocs = await db
      .select()
      .from(envelopeAllocationsTable)
      .where(eq(envelopeAllocationsTable.envelopeId, env.id));
    const spent = round2(allocs.reduce((s, a) => s + num(a.amount), 0));
    await db
      .update(envelopesTable)
      .set({ spentAmount: String(spent), updatedAt: new Date() })
      .where(eq(envelopesTable.id, env.id));
  }
  return db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cardCycleId));
}

/* ---------------------------------------------------------------- STEP 4 */

export interface RollupResult {
  accumulatedTotal: number;
  plannedTotal: number;
  invariantOk: boolean;
  postedChargesTotal: number;
}

/**
 * Roll the cycle up: accumulated_total = sum of all allocations (envelopes +
 * bills — the whole card's actual spend), planned_total = envelope planned +
 * bill expected. Verifies the invariant that allocations equal the sum of
 * posted charges in the window (Misc guarantees nothing is dropped).
 */
export async function rollupCycle(cardCycleId: number): Promise<RollupResult> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cardCycleId));
  if (!cycle) return { accumulatedTotal: 0, plannedTotal: 0, invariantOk: false, postedChargesTotal: 0 };

  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cardCycleId));
  const cycleBills = await db.select().from(cardCycleBillsTable).where(eq(cardCycleBillsTable.cardCycleId, cardCycleId));

  const envelopeIds = envelopes.map((e) => e.id);
  const billIds = cycleBills.map((b) => b.id);
  // Dedupe by allocation id so a malformed row with both targets set can
  // never be counted twice (DB CHECK enforces XOR, this is belt-and-braces).
  const allocsById = new Map(
    [
      ...(envelopeIds.length
        ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.envelopeId, envelopeIds))
        : []),
      ...(billIds.length
        ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.cardCycleBillId, billIds))
        : []),
    ].map((a) => [a.id, a]),
  );
  const allocs = [...allocsById.values()];

  const accumulatedTotal = round2(allocs.reduce((s, a) => s + num(a.amount), 0));
  // planned_total sums ALL envelopes including any carryover. Note: a
  // carryover's planned_amount is last cycle's already-planned food budget
  // relocating to where the charges will post — it is expected spend for
  // THIS cycle's window, but summing planned_total across cycles would count
  // that budget twice. Consumers comparing plans across cycles should treat
  // carryover as relocated, not new, budget.
  const plannedTotal = round2(
    envelopes.reduce((s, e) => s + num(e.plannedAmount), 0) +
    cycleBills.reduce((s, b) => s + num(b.expectedAmount), 0),
  );

  // Invariant: accumulated must equal the sum of ALL posted charges on the
  // card within the cycle window.
  let postedChargesTotal = 0;
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, cycle.accountId));
  if (account?.plaidAccountId) {
    const txns = await db
      .select()
      .from(plaidTransactionsTable)
      .where(and(
        eq(plaidTransactionsTable.accountId, account.plaidAccountId),
        gt(plaidTransactionsTable.amount, "0"),
        eq(plaidTransactionsTable.pending, false),
        gte(plaidTransactionsTable.date, cycle.cycleStart),
        lte(plaidTransactionsTable.date, cycle.cycleEnd),
      ));
    postedChargesTotal = round2(txns.reduce((s, t) => s + num(t.amount), 0));
  }
  const invariantOk = Math.abs(accumulatedTotal - postedChargesTotal) < 0.005;
  if (!invariantOk) {
    console.warn(
      `[cycle ${cardCycleId}] INVARIANT VIOLATION: allocated ${accumulatedTotal} != posted charges ${postedChargesTotal} — a charge escaped allocation`,
    );
  }

  await db
    .update(cardCyclesTable)
    .set({
      accumulatedTotal: String(accumulatedTotal),
      plannedTotal: String(plannedTotal),
      updatedAt: new Date(),
    })
    .where(eq(cardCyclesTable.id, cardCycleId));

  return { accumulatedTotal, plannedTotal, invariantOk, postedChargesTotal };
}

/* ------------------------------------------------- STAGE 3b: CARRYOVER */

/** ISO date string for the day after `iso` (YYYY-MM-DD, UTC-safe). */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface CarryoverResult {
  carryover: Envelope | null;
  nextCycleId: number | null;
  foodRemaining: number;
}

/**
 * When a cycle closes with unspent Food budget, move the remainder into the
 * NEXT cycle as a one-time 'carryover' envelope so late-posting grocery
 * charges drain it instead of appearing as brand-new spending.
 *
 * Idempotent: carryover identity is source_cycle_id (unique index — one
 * carryover per closing cycle), independent of envelope name. Re-runs update
 * planned_amount and re-assert the carryover-defining fields. A user envelope
 * that happens to be named 'Food carryover' is never hijacked; on a name
 * collision the carryover gets a disambiguated name.
 */
export async function generateCarryover(closingCycleId: number): Promise<CarryoverResult> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, closingCycleId));
  if (!cycle) return { carryover: null, nextCycleId: null, foodRemaining: 0 };

  // Only closed cycles (past cycle_end) generate carryover.
  const todayIso = new Date().toISOString().slice(0, 10);
  if (todayIso <= cycle.cycleEnd) return { carryover: null, nextCycleId: null, foodRemaining: 0 };

  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, closingCycleId));
  const food = envelopes.find((e) => e.envelopeType === "food" && !e.isCarryover);
  const foodRemaining = food ? round2(Math.max(0, num(food.plannedAmount) - num(food.spentAmount))) : 0;

  // Find (or generate) the next cycle for the same account.
  const nextStart = dayAfter(cycle.cycleEnd);
  const findNext = () =>
    db.select().from(cardCyclesTable).where(and(
      eq(cardCyclesTable.accountId, cycle.accountId),
      eq(cardCyclesTable.cycleStart, nextStart),
    ));
  let [next] = await findNext();
  if (!next && foodRemaining > 0) {
    const { generateCyclesForAccount } = await import("./card-cycles");
    await generateCyclesForAccount(cycle.accountId);
    [next] = await findNext();
  }
  if (foodRemaining <= 0 || !next) {
    return { carryover: null, nextCycleId: next?.id ?? null, foodRemaining };
  }

  // Carryover-defining fields, re-asserted on every run so the row can't drift.
  const defining = {
    note: "Carryover unspent from last month\u2019s weekly food",
    category: "Food",
    matchCategories: ["FOOD_AND_DRINK_GROCERIES"],
    plannedAmount: String(foodRemaining),
    envelopeType: "carryover",
    isCarryover: true,
    isCatchall: false,
    recurring: false, // one-time; never copied forward
  };

  const [existing] = await db
    .select()
    .from(envelopesTable)
    .where(eq(envelopesTable.sourceCycleId, closingCycleId));
  if (existing) {
    const [carryover] = await db
      .update(envelopesTable)
      .set({ ...defining, updatedAt: new Date() })
      .where(eq(envelopesTable.id, existing.id))
      .returning();
    return { carryover, nextCycleId: next.id, foodRemaining };
  }

  const insertCarryover = (name: string) =>
    db
      .insert(envelopesTable)
      .values({
        userId: cycle.userId,
        cardCycleId: next!.id,
        sourceCycleId: closingCycleId,
        name,
        ...defining,
      })
      .returning();

  let carryover: Envelope;
  try {
    [carryover] = await insertCarryover("Food carryover");
  } catch (err: unknown) {
    // UNIQUE(card_cycle_id, name) collision with a user-created envelope of
    // the same name — never hijack it; use a disambiguated name instead.
    // (Drizzle wraps the pg error, so check the cause chain for 23505.)
    const pgCode =
      (err as { code?: string }).code ??
      ((err as { cause?: { code?: string } }).cause?.code);
    if (pgCode === "23505") {
      [carryover] = await insertCarryover(`Food carryover (from ${cycle.cycleStart})`);
    } else {
      throw err;
    }
  }

  return { carryover, nextCycleId: next.id, foodRemaining };
}

/**
 * Mark a cycle closed (only if past its cycle_end) and generate carryover.
 * Returns null if the cycle isn't past its end yet.
 */
export async function closeCycle(cardCycleId: number): Promise<CarryoverResult | null> {
  const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cardCycleId));
  if (!cycle) return null;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (todayIso <= cycle.cycleEnd) return null;
  if (cycle.status === "open") {
    await db.update(cardCyclesTable).set({ status: "closed", updatedAt: new Date() }).where(eq(cardCyclesTable.id, cardCycleId));
  }
  return generateCarryover(cardCycleId);
}

/* ---------------------------------------------------------------- STEP 5 */

export interface ProcessCycleSummary {
  billsPopulated: number;
  transactionsAllocated: number;
  byTarget: Array<{ target: string; type: "envelope" | "bill"; count: number; amount: number }>;
  accumulatedTotal: number;
  plannedTotal: number;
  invariantOk: boolean;
}

/** Orchestrate: populate bills -> allocate -> recompute spent -> rollup. */
export async function processCycle(cardCycleId: number): Promise<ProcessCycleSummary> {
  const cycleBills = await populateCycleBills(cardCycleId);
  const { transactionsAllocated } = await allocateTransactionsForCycle(cardCycleId);
  const envelopes = await recomputeEnvelopeSpent(cardCycleId);
  const rollup = await rollupCycle(cardCycleId);

  // Per-target breakdown for the summary.
  const billNames = new Map<number, string>();
  if (cycleBills.length) {
    const bills = await db.select().from(billsTable).where(inArray(billsTable.id, cycleBills.map((b) => b.billId)));
    const byBillId = new Map(bills.map((b) => [b.id, b.billName]));
    for (const cb of cycleBills) billNames.set(cb.id, byBillId.get(cb.billId) ?? `bill ${cb.billId}`);
  }

  const byTarget: ProcessCycleSummary["byTarget"] = [];
  for (const env of envelopes) {
    const allocs = await db.select().from(envelopeAllocationsTable).where(eq(envelopeAllocationsTable.envelopeId, env.id));
    if (allocs.length) {
      byTarget.push({ target: env.name, type: "envelope", count: allocs.length, amount: round2(allocs.reduce((s, a) => s + num(a.amount), 0)) });
    }
  }
  for (const cb of cycleBills) {
    const allocs = await db.select().from(envelopeAllocationsTable).where(eq(envelopeAllocationsTable.cardCycleBillId, cb.id));
    if (allocs.length) {
      byTarget.push({ target: billNames.get(cb.id) ?? `bill ${cb.billId}`, type: "bill", count: allocs.length, amount: round2(allocs.reduce((s, a) => s + num(a.amount), 0)) });
    }
  }

  return {
    billsPopulated: cycleBills.length,
    transactionsAllocated,
    byTarget,
    accumulatedTotal: rollup.accumulatedTotal,
    plannedTotal: rollup.plannedTotal,
    invariantOk: rollup.invariantOk,
  };
}
