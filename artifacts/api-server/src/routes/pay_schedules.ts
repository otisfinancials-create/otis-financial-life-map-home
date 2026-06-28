import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, paySchedulesTable } from "@workspace/db";
import {
  CreatePayScheduleBody,
  UpdatePayScheduleBody,
  GetPayScheduleParams,
  UpdatePayScheduleParams,
  DeletePayScheduleParams,
  ListPaySchedulesResponse,
  CreatePayScheduleResponse,
  GetPayScheduleResponse,
  UpdatePayScheduleResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/pay-schedules", async (req, res): Promise<void> => {
  req.log.info("Fetching pay schedules");
  const schedules = await db
    .select()
    .from(paySchedulesTable)
    .where(eq(paySchedulesTable.userId, req.userId))
    .orderBy(paySchedulesTable.employerName);
  res.json(ListPaySchedulesResponse.parse(schedules.map(serialize)));
});

router.post("/pay-schedules", async (req, res): Promise<void> => {
  const parsed = CreatePayScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [schedule] = await db.insert(paySchedulesTable).values({
    ...parsed.data,
    userId: req.userId,
    amount: String(parsed.data.amount),
  }).returning();
  res.status(201).json(CreatePayScheduleResponse.parse(serialize(schedule)));
});

router.get("/pay-schedules/:id", async (req, res): Promise<void> => {
  const params = GetPayScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [schedule] = await db
    .select()
    .from(paySchedulesTable)
    .where(and(eq(paySchedulesTable.id, params.data.id), eq(paySchedulesTable.userId, req.userId)));
  if (!schedule) {
    res.status(404).json({ error: "Pay schedule not found" });
    return;
  }
  res.json(GetPayScheduleResponse.parse(serialize(schedule)));
});

router.patch("/pay-schedules/:id", async (req, res): Promise<void> => {
  const params = UpdatePayScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePayScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amount: rawPayAmount, ...restPayData } = parsed.data;
  const [schedule] = await db
    .update(paySchedulesTable)
    .set({
      ...restPayData,
      ...(rawPayAmount !== undefined && { amount: String(rawPayAmount) }),
      updatedAt: new Date(),
    })
    .where(and(eq(paySchedulesTable.id, params.data.id), eq(paySchedulesTable.userId, req.userId)))
    .returning();
  if (!schedule) {
    res.status(404).json({ error: "Pay schedule not found" });
    return;
  }
  res.json(UpdatePayScheduleResponse.parse(serialize(schedule)));
});

router.delete("/pay-schedules/:id", async (req, res): Promise<void> => {
  const params = DeletePayScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [schedule] = await db
    .delete(paySchedulesTable)
    .where(and(eq(paySchedulesTable.id, params.data.id), eq(paySchedulesTable.userId, req.userId)))
    .returning();
  if (!schedule) {
    res.status(404).json({ error: "Pay schedule not found" });
    return;
  }
  res.sendStatus(204);
});

function serialize(s: typeof paySchedulesTable.$inferSelect) {
  return {
    ...s,
    amount: parseFloat(String(s.amount)),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export default router;
