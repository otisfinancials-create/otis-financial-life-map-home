import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, billsTable, forecastedTransactionsTable } from "@workspace/db";
import {
  CreateBillBody,
  UpdateBillBody,
  GetBillParams,
  UpdateBillParams,
  DeleteBillParams,
  ListBillsResponse,
  CreateBillResponse,
  GetBillResponse,
  UpdateBillResponse,
  GetUpcomingBillsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// For non-monthly bills the due day is defined by the first bill date, so keep
// `dueDay` in sync with `startDate` server-side (clients may not set it, and
// `/bills/upcoming` and due-day displays depend on it being consistent).
function canonicalizeDueDay<T extends { frequency?: string | null; startDate?: string | null; dueDay?: number | null }>(
  data: T,
): T {
  if (data.frequency && data.frequency !== "monthly" && data.startDate) {
    const day = Number(data.startDate.slice(8, 10));
    if (!Number.isNaN(day)) return { ...data, dueDay: day };
  }
  return data;
}

router.get("/bills", async (req, res): Promise<void> => {
  req.log.info("Fetching bills");
  const bills = await db
    .select()
    .from(billsTable)
    .where(eq(billsTable.userId, req.userId))
    .orderBy(billsTable.billName);
  res.json(ListBillsResponse.parse(bills.map(serializeBill)));
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = canonicalizeDueDay(parsed.data);
  const [bill] = await db.insert(billsTable).values({
    ...data,
    userId: req.userId,
    amount: String(data.amount),
    isVariable: data.isVariable ?? false,
    isActive: data.isActive ?? true,
  }).returning();
  res.status(201).json(CreateBillResponse.parse(serializeBill(bill)));
});

router.get("/bills/upcoming", async (req, res): Promise<void> => {
  const today = new Date();
  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), eq(billsTable.userId, req.userId)));

  const upcoming = bills
    .map((bill) => {
      const dueDay = bill.dueDay;
      let dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      if (dueDate < today) {
        dueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
      }
      const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return {
        id: bill.id,
        billName: bill.billName,
        category: bill.category,
        amount: parseFloat(String(bill.amount)),
        dueDate: dueDate.toISOString().split("T")[0],
        daysUntilDue,
        paymentMethod: bill.paymentMethod,
      };
    })
    .filter((b) => b.daysUntilDue <= 30)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  res.json(GetUpcomingBillsResponse.parse(upcoming));
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const params = GetBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [bill] = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(GetBillResponse.parse(serializeBill(bill)));
});

router.patch("/bills/:id", async (req, res): Promise<void> => {
  const params = UpdateBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Canonicalize dueDay when frequency + startDate are being set together.
  const canonicalized = canonicalizeDueDay(parsed.data);
  const { amount: rawBillAmount, ...restBillData } = canonicalized;
  const [bill] = await db
    .update(billsTable)
    .set({
      ...restBillData,
      ...(rawBillAmount !== undefined && { amount: String(rawBillAmount) }),
      updatedAt: new Date(),
    })
    .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)))
    .returning();
  if (!bill) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(UpdateBillResponse.parse(serializeBill(bill)));
});

router.delete("/bills/:id", async (req, res): Promise<void> => {
  const params = DeleteBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  // Hard delete: remove the bill and all of its forecasted transactions.
  const deleted = await db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(billsTable)
      .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
    if (!bill) return null;

    await tx
      .delete(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.sourceBillId, params.data.id),
        eq(forecastedTransactionsTable.userId, req.userId),
      ));
    await tx
      .delete(billsTable)
      .where(and(eq(billsTable.id, params.data.id), eq(billsTable.userId, req.userId)));
    return bill;
  });

  if (!deleted) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.sendStatus(204);
});

function serializeBill(bill: typeof billsTable.$inferSelect) {
  return {
    ...bill,
    amount: parseFloat(String(bill.amount)),
    createdAt: bill.createdAt.toISOString(),
    updatedAt: bill.updatedAt.toISOString(),
  };
}

export default router;
