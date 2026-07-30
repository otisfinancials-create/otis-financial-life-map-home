import { Router, type IRouter } from "express";
import { and, eq, gt, gte, asc, inArray, sql } from "drizzle-orm";
import { db, cardCyclesTable, envelopesTable, cardCycleBillsTable, billsTable, envelopeAllocationsTable, accountsTable, type Envelope, type CardCycle, type EnvelopeAllocation } from "@workspace/db";
import {
  ListCycleEnvelopesParams,
  ListCycleEnvelopesResponse,
  CreateCycleEnvelopeParams,
  CreateCycleEnvelopeBody,
  CreateCycleEnvelopeResponse,
  UpdateEnvelopeParams,
  UpdateEnvelopeBody,
  UpdateEnvelopeResponse,
  DeleteEnvelopeParams,
} from "@workspace/api-zod";
import { foodPlannedAmount } from "../services/envelopes";
import { processCycle, closeCycle, rollupCycle, recomputeEnvelopeSpent } from "../services/cycle-processing";
import { regenerateForecastForUser } from "./forecast";
import {
  ProcessCycleParams, ProcessCycleResponse, CloseCycleParams, CloseCycleResponse,
  GetCycleBreakdownParams, GetCycleBreakdownResponse,
  ListCycleChargesParams, ListCycleChargesResponse,
  CreateCycleChargeParams, CreateCycleChargeBody, CreateCycleChargeResponse,
  UpdateCycleChargeParams, UpdateCycleChargeBody, UpdateCycleChargeResponse,
  DeleteCycleChargeParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeEnvelope(e: Envelope) {
  return {
    id: e.id,
    cardCycleId: e.cardCycleId,
    name: e.name,
    category: e.category,
    plannedAmount: e.plannedAmount != null ? parseFloat(String(e.plannedAmount)) : 0,
    spentAmount: e.spentAmount != null ? parseFloat(String(e.spentAmount)) : 0,
    cadence: e.cadence,
    note: e.note,
    envelopeType: e.envelopeType ?? "standard",
    isCatchall: e.isCatchall ?? false,
    recurring: e.recurring ?? false,
    weeklyRate: e.weeklyRate != null ? parseFloat(String(e.weeklyRate)) : null,
    isCarryover: e.isCarryover ?? false,
    matchCategories: e.matchCategories ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** Ordering: food first, then standard, catch-all (Misc) last; name tiebreak. */
function orderEnvelopes(envelopes: Envelope[]): Envelope[] {
  const rank = (e: Envelope) => (e.envelopeType === "food" ? 0 : e.isCatchall ? 2 : 1);
  return [...envelopes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function ownedCycle(cycleId: number, userId: string): Promise<CardCycle | undefined> {
  const [cycle] = await db
    .select()
    .from(cardCyclesTable)
    .where(and(eq(cardCyclesTable.id, cycleId), eq(cardCyclesTable.userId, userId)));
  return cycle;
}

router.get("/cycles/:cycleId/envelopes", async (req, res): Promise<void> => {
  const params = ListCycleEnvelopesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cycle.id));
  res.json(ListCycleEnvelopesResponse.parse(orderEnvelopes(envelopes).map(serializeEnvelope)));
});

router.post("/cycles/:cycleId/process", async (req, res): Promise<void> => {
  const params = ProcessCycleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  const summary = await processCycle(cycle.id);
  res.json(ProcessCycleResponse.parse(summary));
});

router.post("/cycles/:cycleId/close", async (req, res): Promise<void> => {
  const params = CloseCycleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  const result = await closeCycle(cycle.id);
  if (!result) {
    res.status(400).json({ error: "Cycle is not past its cycle_end yet" });
    return;
  }
  res.json(CloseCycleResponse.parse({
    carryover: result.carryover ? serializeEnvelope(result.carryover) : null,
    nextCycleId: result.nextCycleId,
    foodRemaining: result.foodRemaining,
  }));
});

// Read-only composition of a cycle's payment (forecast drill-down):
// envelopes + bills with amounts. Full interactive cycle UI is Stage 5.
router.get("/cycles/:cycleId/breakdown", async (req, res): Promise<void> => {
  const params = GetCycleBreakdownParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  // Self-heal: an open cycle with zero bill rows but active card-paid bills
  // predates the population fix (bills confirmed before cycles existed).
  // Process it once so the composition fills in on view.
  const existingBillRows = await db
    .select({ id: cardCycleBillsTable.id })
    .from(cardCycleBillsTable)
    .where(eq(cardCycleBillsTable.cardCycleId, cycle.id));
  if (existingBillRows.length === 0 && cycle.status === "open") {
    const activeCardBills = await db
      .select({ id: billsTable.id })
      .from(billsTable)
      .where(and(
        eq(billsTable.userId, req.userId),
        eq(billsTable.paymentAccountId, cycle.accountId),
        eq(billsTable.isActive, true),
      ));
    if (activeCardBills.length > 0) await processCycle(cycle.id);
  }
  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cycle.id));
  const cycleBills = await db
    .select({ cb: cardCycleBillsTable, billName: billsTable.billName })
    .from(cardCycleBillsTable)
    .innerJoin(billsTable, eq(cardCycleBillsTable.billId, billsTable.id))
    .where(eq(cardCycleBillsTable.cardCycleId, cycle.id));
  res.json(GetCycleBreakdownResponse.parse({
    cycleId: cycle.id,
    cycleStart: cycle.cycleStart,
    cycleEnd: cycle.cycleEnd,
    dueDate: cycle.dueDate,
    status: cycle.status ?? "open",
    accumulatedTotal: parseFloat(String(cycle.accumulatedTotal ?? "0")) || 0,
    plannedTotal: parseFloat(String(cycle.plannedTotal ?? "0")) || 0,
    envelopes: orderEnvelopes(envelopes).map(serializeEnvelope),
    bills: cycleBills.map(({ cb, billName }) => ({
      id: cb.id,
      billName,
      expectedAmount: parseFloat(String(cb.expectedAmount ?? "0")) || 0,
      actualAmount: cb.actualAmount == null ? null : parseFloat(String(cb.actualAmount)),
      status: cb.status ?? "pending",
    })),
  }));
});

/* ---------------------------------------------------------------- manual charges */

/**
 * Re-derive everything downstream of an allocation change: envelope spent
 * amounts, bill actual/status, cycle rollup, and the forecast projection.
 * Reuses the Stage 1-3 engine — same math as the auto (Plaid) path.
 */
async function recomputeAfterAllocationChange(cycle: CardCycle, userId: string): Promise<void> {
  await recomputeEnvelopeSpent(cycle.id);
  // Bill actual/status from allocations (mirror of the auto path's recompute).
  const cycleBills = await db.select().from(cardCycleBillsTable).where(eq(cardCycleBillsTable.cardCycleId, cycle.id));
  for (const cb of cycleBills) {
    const allocs = await db.select().from(envelopeAllocationsTable).where(eq(envelopeAllocationsTable.cardCycleBillId, cb.id));
    const total = Math.round(allocs.reduce((s, a) => s + parseFloat(String(a.amount)), 0) * 100) / 100;
    await db
      .update(cardCycleBillsTable)
      .set({ actualAmount: allocs.length ? String(total) : null, status: allocs.length ? "hit" : "pending" })
      .where(eq(cardCycleBillsTable.id, cb.id));
  }
  await rollupCycle(cycle.id);
  await regenerateForecastForUser(userId);
}

function serializeCharge(a: EnvelopeAllocation, targetName: string) {
  return {
    id: a.id,
    amount: parseFloat(String(a.amount)),
    source: a.source,
    envelopeId: a.envelopeId,
    cardCycleBillId: a.cardCycleBillId,
    txnDate: a.txnDate,
    description: a.description,
    targetName,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Manual charges are only for cards without a bank connection — Plaid cards get allocations from real transactions. */
async function isManualCardCycle(cycle: CardCycle): Promise<boolean> {
  const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, cycle.accountId));
  return account != null && account.plaidAccountId == null;
}

/** Envelope + bill lookup maps for a cycle, used to resolve target names and validate ownership. */
async function cycleTargets(cycleId: number) {
  const envelopes = await db.select().from(envelopesTable).where(eq(envelopesTable.cardCycleId, cycleId));
  const cycleBills = await db
    .select({ cb: cardCycleBillsTable, billName: billsTable.billName })
    .from(cardCycleBillsTable)
    .innerJoin(billsTable, eq(cardCycleBillsTable.billId, billsTable.id))
    .where(eq(cardCycleBillsTable.cardCycleId, cycleId));
  return {
    envelopeById: new Map(envelopes.map((e) => [e.id, e])),
    billById: new Map(cycleBills.map(({ cb, billName }) => [cb.id, { cb, billName }])),
  };
}

router.get("/cycles/:cycleId/charges", async (req, res): Promise<void> => {
  const params = ListCycleChargesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  const { envelopeById, billById } = await cycleTargets(cycle.id);
  const envelopeIds = [...envelopeById.keys()];
  const billIds = [...billById.keys()];
  const allocs = [
    ...(envelopeIds.length ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.envelopeId, envelopeIds)) : []),
    ...(billIds.length ? await db.select().from(envelopeAllocationsTable).where(inArray(envelopeAllocationsTable.cardCycleBillId, billIds)) : []),
  ].filter((a) => a.source === "manual");
  allocs.sort((a, b) => (b.txnDate ?? "").localeCompare(a.txnDate ?? "") || b.id - a.id);
  res.json(ListCycleChargesResponse.parse(allocs.map((a) => serializeCharge(
    a,
    a.envelopeId != null ? envelopeById.get(a.envelopeId)?.name ?? "Envelope" : billById.get(a.cardCycleBillId!)?.billName ?? "Bill",
  ))));
});

router.post("/cycles/:cycleId/charges", async (req, res): Promise<void> => {
  const params = CreateCycleChargeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreateCycleChargeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  if (!(await isManualCardCycle(cycle))) {
    res.status(400).json({ error: "This card is connected to your bank — charges are recorded automatically from its transactions" });
    return;
  }
  const { amount, txnDate, description, envelopeId, cardCycleBillId } = body.data;
  if ((envelopeId == null) === (cardCycleBillId == null)) {
    res.status(400).json({ error: "Pick exactly one target: an envelope or a bill" });
    return;
  }
  if (txnDate < cycle.cycleStart || txnDate > cycle.cycleEnd) {
    res.status(400).json({ error: `Charge date must fall within the cycle window (${cycle.cycleStart} – ${cycle.cycleEnd})` });
    return;
  }
  const { envelopeById, billById } = await cycleTargets(cycle.id);
  const targetName = envelopeId != null ? envelopeById.get(envelopeId)?.name : billById.get(cardCycleBillId!)?.billName;
  if (!targetName) {
    res.status(400).json({ error: "Target envelope or bill does not belong to this cycle" });
    return;
  }
  const [created] = await db
    .insert(envelopeAllocationsTable)
    .values({
      userId: req.userId,
      plaidTransactionId: null,
      envelopeId: envelopeId ?? null,
      cardCycleBillId: cardCycleBillId ?? null,
      amount: String(amount),
      source: "manual",
      txnDate,
      description: description ?? null,
    })
    .returning();
  await recomputeAfterAllocationChange(cycle, req.userId);
  res.status(201).json(CreateCycleChargeResponse.parse(serializeCharge(created, targetName)));
});

/** Load a manual charge owned by the user, plus the cycle it belongs to. */
async function ownedManualCharge(id: number, userId: string): Promise<{ alloc: EnvelopeAllocation; cycle: CardCycle } | { error: string; status: number }> {
  const [alloc] = await db
    .select()
    .from(envelopeAllocationsTable)
    .where(and(eq(envelopeAllocationsTable.id, id), eq(envelopeAllocationsTable.userId, userId)));
  if (!alloc) return { error: "Charge not found", status: 404 };
  if (alloc.source !== "manual") return { error: "Automatic allocations can't be edited — they come from your card's transactions", status: 400 };
  const cycleId = alloc.envelopeId != null
    ? (await db.select().from(envelopesTable).where(eq(envelopesTable.id, alloc.envelopeId)))[0]?.cardCycleId
    : (await db.select().from(cardCycleBillsTable).where(eq(cardCycleBillsTable.id, alloc.cardCycleBillId!)))[0]?.cardCycleId;
  const cycle = cycleId != null ? (await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, cycleId)))[0] : undefined;
  if (!cycle) return { error: "Charge not found", status: 404 };
  if (!(await isManualCardCycle(cycle))) {
    return { error: "This card is connected to your bank — charges are recorded automatically from its transactions", status: 400 };
  }
  return { alloc, cycle };
}

router.patch("/charges/:id", async (req, res): Promise<void> => {
  const params = UpdateCycleChargeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateCycleChargeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const loaded = await ownedManualCharge(params.data.id, req.userId);
  if ("error" in loaded) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  const { alloc, cycle } = loaded;
  const { amount, txnDate, description, envelopeId, cardCycleBillId } = body.data;

  // Resolve the (possibly retargeted) target, still within the same cycle.
  const nextEnvelopeId = envelopeId !== undefined || cardCycleBillId !== undefined ? envelopeId ?? null : alloc.envelopeId;
  const nextBillId = envelopeId !== undefined || cardCycleBillId !== undefined ? cardCycleBillId ?? null : alloc.cardCycleBillId;
  if ((nextEnvelopeId == null) === (nextBillId == null)) {
    res.status(400).json({ error: "Pick exactly one target: an envelope or a bill" });
    return;
  }
  const nextDate = txnDate ?? alloc.txnDate;
  if (nextDate != null && (nextDate < cycle.cycleStart || nextDate > cycle.cycleEnd)) {
    res.status(400).json({ error: `Charge date must fall within the cycle window (${cycle.cycleStart} – ${cycle.cycleEnd})` });
    return;
  }
  const { envelopeById, billById } = await cycleTargets(cycle.id);
  const targetName = nextEnvelopeId != null ? envelopeById.get(nextEnvelopeId)?.name : billById.get(nextBillId!)?.billName;
  if (!targetName) {
    res.status(400).json({ error: "Target envelope or bill does not belong to this cycle" });
    return;
  }
  const [updated] = await db
    .update(envelopeAllocationsTable)
    .set({
      ...(amount !== undefined && { amount: String(amount) }),
      ...(txnDate !== undefined && { txnDate }),
      ...(description !== undefined && { description }),
      envelopeId: nextEnvelopeId,
      cardCycleBillId: nextBillId,
    })
    .where(eq(envelopeAllocationsTable.id, alloc.id))
    .returning();
  await recomputeAfterAllocationChange(cycle, req.userId);
  res.json(UpdateCycleChargeResponse.parse(serializeCharge(updated, targetName)));
});

router.delete("/charges/:id", async (req, res): Promise<void> => {
  const params = DeleteCycleChargeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const loaded = await ownedManualCharge(params.data.id, req.userId);
  if ("error" in loaded) {
    res.status(loaded.status).json({ error: loaded.error });
    return;
  }
  await db.delete(envelopeAllocationsTable).where(eq(envelopeAllocationsTable.id, loaded.alloc.id));
  await recomputeAfterAllocationChange(loaded.cycle, req.userId);
  res.sendStatus(204);
});

router.post("/cycles/:cycleId/envelopes", async (req, res): Promise<void> => {
  const params = CreateCycleEnvelopeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = CreateCycleEnvelopeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const cycle = await ownedCycle(params.data.cycleId, req.userId);
  if (!cycle) {
    res.status(404).json({ error: "Cycle not found" });
    return;
  }
  const { scope = "this-cycle", envelopeType = "standard", weeklyRate, plannedAmount, matchCategories, ...rest } = body.data;
  const recurring = scope === "all-future";

  const plannedFor = (c: CardCycle): string => {
    if (envelopeType === "food" && weeklyRate != null) return String(foodPlannedAmount(c, weeklyRate));
    return String(plannedAmount ?? 0);
  };

  const values = {
    userId: req.userId,
    name: rest.name,
    category: rest.category ?? null,
    cadence: rest.cadence ?? (envelopeType === "food" ? "weekly" : "one-time"),
    note: rest.note ?? null,
    envelopeType,
    recurring,
    weeklyRate: weeklyRate != null ? String(weeklyRate) : null,
    matchCategories: matchCategories ?? null,
  };

  const [created] = await db
    .insert(envelopesTable)
    .values({ ...values, cardCycleId: cycle.id, plannedAmount: plannedFor(cycle) })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    res.status(400).json({ error: "An envelope with that name already exists in this cycle" });
    return;
  }

  if (recurring) {
    // Keep already-generated future cycles for this account consistent.
    const futureCycles = await db
      .select()
      .from(cardCyclesTable)
      .where(and(
        eq(cardCyclesTable.accountId, cycle.accountId),
        eq(cardCyclesTable.userId, req.userId),
        gt(cardCyclesTable.cycleStart, cycle.cycleStart),
      ))
      .orderBy(asc(cardCyclesTable.cycleStart));
    for (const fc of futureCycles) {
      const existing = await db
        .select()
        .from(envelopesTable)
        .where(eq(envelopesTable.cardCycleId, fc.id));
      if (existing.some((e) => e.name.trim().toLowerCase() === rest.name.trim().toLowerCase())) continue;
      await db
        .insert(envelopesTable)
        .values({ ...values, cardCycleId: fc.id, plannedAmount: plannedFor(fc) })
        .onConflictDoNothing();
    }
  }

  // Planned totals changed: refresh rollups (this + any future cycles the
  // envelope was seeded into) and the forecast projection.
  await rollupCycle(cycle.id);
  if (recurring) {
    const futures = await db
      .select({ id: cardCyclesTable.id })
      .from(cardCyclesTable)
      .where(and(eq(cardCyclesTable.accountId, cycle.accountId), gt(cardCyclesTable.cycleStart, cycle.cycleStart)));
    for (const fc of futures) await rollupCycle(fc.id);
  }
  await regenerateForecastForUser(req.userId);

  res.status(201).json(CreateCycleEnvelopeResponse.parse(serializeEnvelope(created)));
});

router.patch("/envelopes/:id", async (req, res): Promise<void> => {
  const params = UpdateEnvelopeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateEnvelopeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [envelope] = await db
    .select()
    .from(envelopesTable)
    .where(and(eq(envelopesTable.id, params.data.id), eq(envelopesTable.userId, req.userId)));
  if (!envelope) {
    res.status(404).json({ error: "Envelope not found" });
    return;
  }

  const { plannedAmount, weeklyRate, ...rest } = body.data;
  const set: Partial<typeof envelopesTable.$inferInsert> = {
    ...rest,
    updatedAt: new Date(),
  };
  if (plannedAmount !== undefined) set.plannedAmount = String(plannedAmount);
  if (weeklyRate !== undefined) set.weeklyRate = weeklyRate != null ? String(weeklyRate) : null;

  // Food envelopes derive planned_amount from Mondays-in-cycle × weekly_rate.
  if (envelope.envelopeType === "food" && weeklyRate !== undefined && weeklyRate != null) {
    const [cycle] = await db.select().from(cardCyclesTable).where(eq(cardCyclesTable.id, envelope.cardCycleId));
    if (cycle) set.plannedAmount = String(foodPlannedAmount(cycle, weeklyRate));
  }

  const [updated] = await db
    .update(envelopesTable)
    .set(set)
    .where(eq(envelopesTable.id, envelope.id))
    .returning();

  // Planned totals may have changed: recompute the cycle rollup and the
  // forecast's projected payment so the UI reflects the edit immediately.
  if (plannedAmount !== undefined || weeklyRate !== undefined) {
    await rollupCycle(envelope.cardCycleId);
    await regenerateForecastForUser(req.userId);
  }
  res.json(UpdateEnvelopeResponse.parse(serializeEnvelope(updated)));
});

router.delete("/envelopes/:id", async (req, res): Promise<void> => {
  const params = DeleteEnvelopeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [envelope] = await db
    .select()
    .from(envelopesTable)
    .where(and(eq(envelopesTable.id, params.data.id), eq(envelopesTable.userId, req.userId)));
  if (!envelope) {
    res.status(404).json({ error: "Envelope not found" });
    return;
  }
  if (envelope.isCatchall) {
    res.status(400).json({ error: "The catch-all envelope can't be deleted" });
    return;
  }
  // Block deletion while charges are allocated to this envelope — otherwise
  // the FK from envelope_allocations would fail with an opaque 500. The user
  // must re-target or delete the charges first.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(envelopeAllocationsTable)
    .where(eq(envelopeAllocationsTable.envelopeId, envelope.id));
  if (count > 0) {
    res.status(400).json({ error: "This envelope has charges allocated to it — move or delete those charges first" });
    return;
  }
  await db.delete(envelopesTable).where(eq(envelopesTable.id, envelope.id));
  await rollupCycle(envelope.cardCycleId);
  await regenerateForecastForUser(req.userId);
  res.sendStatus(204);
});

export default router;
