import { Router, type IRouter } from "express";
import { and, eq, gt, asc } from "drizzle-orm";
import { db, cardCyclesTable, envelopesTable, cardCycleBillsTable, billsTable, type Envelope, type CardCycle } from "@workspace/db";
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
import { processCycle, closeCycle } from "../services/cycle-processing";
import { ProcessCycleParams, ProcessCycleResponse, CloseCycleParams, CloseCycleResponse, GetCycleBreakdownParams, GetCycleBreakdownResponse } from "@workspace/api-zod";

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
  await db.delete(envelopesTable).where(eq(envelopesTable.id, envelope.id));
  res.sendStatus(204);
});

export default router;
