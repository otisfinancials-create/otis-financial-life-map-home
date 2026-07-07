import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, lifeEventsTable } from "@workspace/db";
import {
  CreateLifeEventBody,
  UpdateLifeEventBody,
  UpdateLifeEventParams,
  DeleteLifeEventParams,
  ListLifeEventsResponse,
  CreateLifeEventResponse,
  UpdateLifeEventResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Clears date/frequency fields that don't apply to the given timing type so that
// switching timing type (e.g. one_time -> recurring) can never leave stale dates
// behind that would corrupt forecast generation or the "upcoming" UI.
function normalizeTimingFields(row: {
  timingType?: string | null;
  eventDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  frequency?: string | null;
}): { eventDate: string | null; startDate: string | null; endDate: string | null; frequency: string | null } {
  if (row.timingType === "one_time") {
    return { eventDate: row.eventDate ?? null, startDate: null, endDate: null, frequency: null };
  }
  if (row.timingType === "spread") {
    return { eventDate: null, startDate: row.startDate ?? null, endDate: row.endDate ?? null, frequency: null };
  }
  // recurring
  return {
    eventDate: null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    frequency: row.frequency ?? null,
  };
}

router.get("/life-events", async (req, res): Promise<void> => {
  req.log.info("Fetching life events");
  const events = await db
    .select()
    .from(lifeEventsTable)
    .where(eq(lifeEventsTable.userId, req.userId))
    .orderBy(lifeEventsTable.eventName);
  res.json(ListLifeEventsResponse.parse(events.map(serializeLifeEvent)));
});

router.post("/life-events", async (req, res): Promise<void> => {
  const parsed = CreateLifeEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [event] = await db
    .insert(lifeEventsTable)
    .values({
      ...parsed.data,
      ...normalizeTimingFields(parsed.data),
      userId: req.userId,
      amount: String(parsed.data.amount),
      isActive: parsed.data.isActive ?? true,
    })
    .returning();
  res.status(201).json(CreateLifeEventResponse.parse(serializeLifeEvent(event)));
});

router.patch("/life-events/:id", async (req, res): Promise<void> => {
  const params = UpdateLifeEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateLifeEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(lifeEventsTable)
    .where(and(eq(lifeEventsTable.id, params.data.id), eq(lifeEventsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Life event not found" });
    return;
  }
  const { amount: rawAmount, ...rest } = parsed.data;
  // Merge the patch over the existing row so timing normalization uses the final
  // state — this clears stale date/frequency fields when timing type changes.
  const merged = { ...existing, ...rest };
  const [event] = await db
    .update(lifeEventsTable)
    .set({
      ...rest,
      ...normalizeTimingFields(merged),
      ...(rawAmount !== undefined && { amount: String(rawAmount) }),
      updatedAt: new Date(),
    })
    .where(and(eq(lifeEventsTable.id, params.data.id), eq(lifeEventsTable.userId, req.userId)))
    .returning();
  if (!event) {
    res.status(404).json({ error: "Life event not found" });
    return;
  }
  res.json(UpdateLifeEventResponse.parse(serializeLifeEvent(event)));
});

router.delete("/life-events/:id", async (req, res): Promise<void> => {
  const params = DeleteLifeEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [event] = await db
    .delete(lifeEventsTable)
    .where(and(eq(lifeEventsTable.id, params.data.id), eq(lifeEventsTable.userId, req.userId)))
    .returning();
  if (!event) {
    res.status(404).json({ error: "Life event not found" });
    return;
  }
  res.sendStatus(204);
});

function serializeLifeEvent(event: typeof lifeEventsTable.$inferSelect) {
  return {
    ...event,
    amount: parseFloat(String(event.amount)),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

export default router;
