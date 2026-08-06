import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, paySchedulesTable, detectedPaySchedulesTable } from "@workspace/db";
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
  DetectPaySchedulesResponse,
  ListDetectedPaySchedulesResponse,
  ConfirmDetectedPayScheduleParams,
  ConfirmDetectedPayScheduleBody,
  ConfirmDetectedPayScheduleResponse,
  DismissDetectedPayScheduleParams,
  DismissDetectedPayScheduleResponse,
} from "@workspace/api-zod";
import { detectPaySchedules } from "../services/pay-detection";

const router: IRouter = Router();

/** Cadences the forecast generator (advanceByFrequency) supports end to end. */
const SUPPORTED_PAY_FREQUENCIES = new Set([
  "weekly", "biweekly", "semi-monthly", "monthly", "quarterly", "semi-annual", "annually",
]);

// ── Pay detection (literal routes MUST mount before /pay-schedules/:id) ─────

router.post("/pay-schedules/detect", async (req, res): Promise<void> => {
  const summary = await detectPaySchedules(req.userId);
  req.log.info(summary, "Pay detection run complete");
  res.json(DetectPaySchedulesResponse.parse(summary));
});

router.get("/pay-schedules/detected", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(detectedPaySchedulesTable)
    .where(and(eq(detectedPaySchedulesTable.userId, req.userId), eq(detectedPaySchedulesTable.status, "pending")))
    .orderBy(desc(detectedPaySchedulesTable.confidence));
  res.json(ListDetectedPaySchedulesResponse.parse(rows.map(serializeDetected)));
});

router.post("/pay-schedules/detected/:id/confirm", async (req, res): Promise<void> => {
  const params = ConfirmDetectedPayScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = ConfirmDetectedPayScheduleBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  // Peek first so a non-pending row gets a 409 (a lost race also lands here);
  // the actual claim below is atomic.
  const [existing] = await db
    .select()
    .from(detectedPaySchedulesTable)
    .where(and(eq(detectedPaySchedulesTable.id, params.data.id), eq(detectedPaySchedulesTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Detected pay schedule not found" });
    return;
  }
  if (existing.status !== "pending") {
    res.status(409).json({ error: `Already ${existing.status}` });
    return;
  }
  // Ambiguous cadence: the user must pick — never guess — and the pick must be
  // one of the offered options. Unambiguous rows only accept a supported cadence.
  const options = Array.isArray(existing.frequencyOptions) ? (existing.frequencyOptions as string[]) : [];
  if (existing.cadenceAmbiguous) {
    if (!body.data.frequency) {
      res.status(400).json({ error: "Cadence is ambiguous; choose a frequency to confirm" });
      return;
    }
    if (!options.includes(body.data.frequency)) {
      res.status(400).json({ error: `Frequency must be one of: ${options.join(", ")}` });
      return;
    }
  } else if (body.data.frequency && !SUPPORTED_PAY_FREQUENCIES.has(body.data.frequency)) {
    res.status(400).json({ error: `Unsupported frequency; use one of: ${[...SUPPORTED_PAY_FREQUENCIES].join(", ")}` });
    return;
  }
  const frequency = body.data.frequency ?? existing.frequency;
  // Atomic claim: only the request that flips pending→confirmed inserts the
  // schedule, so concurrent confirms (double clicks, retries) can't create
  // duplicate pay schedules.
  const schedule = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(detectedPaySchedulesTable)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(
        eq(detectedPaySchedulesTable.id, params.data.id),
        eq(detectedPaySchedulesTable.userId, req.userId),
        eq(detectedPaySchedulesTable.status, "pending"),
      ))
      .returning();
    if (!claimed) return null;
    const [created] = await tx.insert(paySchedulesTable).values({
      userId: req.userId,
      employerName: body.data.employerName ?? claimed.displayName,
      amount: String(body.data.amount ?? parseFloat(String(claimed.amount))),
      frequency,
      nextPayDate: body.data.nextPayDate ?? claimed.nextExpectedDate ?? claimed.lastSeen ?? new Date().toISOString().slice(0, 10),
    }).returning();
    return created!;
  });
  if (!schedule) {
    res.status(409).json({ error: "Already confirmed or dismissed" });
    return;
  }
  req.log.info({ detectedId: existing.id, payScheduleId: schedule.id, frequency }, "Detected pay schedule confirmed");
  res.json(ConfirmDetectedPayScheduleResponse.parse(serialize(schedule)));
});

router.post("/pay-schedules/detected/:id/dismiss", async (req, res): Promise<void> => {
  const params = DismissDetectedPayScheduleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [det] = await db
    .update(detectedPaySchedulesTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(eq(detectedPaySchedulesTable.id, params.data.id), eq(detectedPaySchedulesTable.userId, req.userId)))
    .returning();
  if (!det) {
    res.status(404).json({ error: "Detected pay schedule not found" });
    return;
  }
  res.json(DismissDetectedPayScheduleResponse.parse(serializeDetected(det)));
});

function serializeDetected(d: typeof detectedPaySchedulesTable.$inferSelect) {
  return {
    id: d.id,
    employerKey: d.employerKey,
    displayName: d.displayName,
    amount: parseFloat(String(d.amount)),
    amountMin: d.amountMin != null ? parseFloat(String(d.amountMin)) : null,
    amountMax: d.amountMax != null ? parseFloat(String(d.amountMax)) : null,
    frequency: d.frequency,
    cadenceAmbiguous: d.cadenceAmbiguous,
    frequencyOptions: Array.isArray(d.frequencyOptions) ? (d.frequencyOptions as string[]) : [],
    occurrenceCount: d.occurrenceCount,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    nextExpectedDate: d.nextExpectedDate,
    confidence: parseFloat(String(d.confidence)),
    status: d.status,
  };
}

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
