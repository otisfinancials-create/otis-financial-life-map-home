import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, forecastedTransactionsTable, billsTable, paySchedulesTable } from "@workspace/db";
import {
  CreateForecastedTransactionBody,
  UpdateForecastedTransactionBody,
  UpdateForecastedTransactionParams,
  DeleteForecastedTransactionParams,
  ListForecastQueryParams,
  ListForecastResponse,
  CreateForecastedTransactionResponse,
  GetMonthlyForecastResponse,
  RegenerateForecastResponse,
  UpdateForecastedTransactionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/forecast", async (req, res): Promise<void> => {
  const queryParams = ListForecastQueryParams.safeParse(req.query);
  if (!queryParams.success) {
    res.status(400).json({ error: queryParams.error.message });
    return;
  }

  let query = db.select().from(forecastedTransactionsTable).$dynamic();
  const conditions = [];

  if (queryParams.data.startDate) {
    conditions.push(gte(forecastedTransactionsTable.transactionDate, queryParams.data.startDate));
  }
  if (queryParams.data.endDate) {
    conditions.push(lte(forecastedTransactionsTable.transactionDate, queryParams.data.endDate));
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const rows = await query.orderBy(forecastedTransactionsTable.transactionDate);
  res.json(ListForecastResponse.parse(rows.map(serialize)));
});

router.post("/forecast", async (req, res): Promise<void> => {
  const parsed = CreateForecastedTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [tx] = await db.insert(forecastedTransactionsTable).values({
    ...parsed.data,
    amount: String(parsed.data.amount),
    isActual: parsed.data.isActual ?? false,
    isCommitted: parsed.data.isCommitted ?? false,
  }).returning();
  res.status(201).json(CreateForecastedTransactionResponse.parse(serialize(tx)));
});

router.get("/forecast/monthly", async (req, res): Promise<void> => {
  const today = new Date();
  const rows = await db.select().from(forecastedTransactionsTable);

  const monthlyMap: Record<string, { month: number; year: number; label: string; totalIncome: number; totalExpenses: number }> = {};

  for (let i = 0; i < 12; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = {
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      label: d.toLocaleString("en-US", { month: "short", year: "numeric" }),
      totalIncome: 0,
      totalExpenses: 0,
    };
  }

  for (const row of rows) {
    const d = new Date(row.transactionDate);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) continue;
    const amount = parseFloat(String(row.amount));
    if (row.transactionType === "income") {
      monthlyMap[key].totalIncome += amount;
    } else {
      monthlyMap[key].totalExpenses += amount;
    }
  }

  const result = Object.values(monthlyMap).map((m) => ({
    ...m,
    netCashFlow: m.totalIncome - m.totalExpenses,
  }));

  res.json(GetMonthlyForecastResponse.parse(result));
});

router.post("/forecast/regenerate", async (req, res): Promise<void> => {
  req.log.info("Regenerating forecast");

  // Delete existing non-actual forecasted transactions
  await db.delete(forecastedTransactionsTable).where(
    eq(forecastedTransactionsTable.isActual, false)
  );

  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth() + 12, 0);
  const toInsert: Array<typeof forecastedTransactionsTable.$inferInsert> = [];

  // Generate from bills
  const bills = await db.select().from(billsTable).where(eq(billsTable.isActive, true));
  for (const bill of bills) {
    const amount = parseFloat(String(bill.amount));
    const frequency = bill.frequency;

    let current = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (current < today) {
      current = advanceByFrequency(current, frequency);
    }

    while (current <= endDate) {
      toInsert.push({
        transactionDate: current.toISOString().split("T")[0],
        description: bill.billName,
        amount: String(amount),
        transactionType: "expense",
        category: bill.category,
        sourceBillId: bill.id,
        isActual: false,
        isCommitted: false,
      });
      current = advanceByFrequency(current, frequency);
    }
  }

  // Generate from pay schedules
  const paySchedules = await db.select().from(paySchedulesTable);
  for (const ps of paySchedules) {
    const amount = parseFloat(String(ps.amount));
    let current = new Date(ps.nextPayDate);

    while (current <= endDate) {
      if (current >= today) {
        toInsert.push({
          transactionDate: current.toISOString().split("T")[0],
          description: `Paycheck – ${ps.employerName}`,
          amount: String(amount),
          transactionType: "income",
          category: "salary",
          sourcePayId: ps.id,
          isActual: false,
          isCommitted: false,
        });
      }
      current = advanceByFrequency(current, ps.frequency);
    }
  }

  if (toInsert.length > 0) {
    await db.insert(forecastedTransactionsTable).values(toInsert);
  }

  res.json(RegenerateForecastResponse.parse({ created: toInsert.length, message: `Created ${toInsert.length} forecasted transactions` }));
});

router.patch("/forecast/:id", async (req, res): Promise<void> => {
  const params = UpdateForecastedTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateForecastedTransactionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amount: rawTxAmount, ...restTxData } = parsed.data;
  const [tx] = await db
    .update(forecastedTransactionsTable)
    .set({
      ...restTxData,
      ...(rawTxAmount !== undefined && { amount: String(rawTxAmount) }),
    })
    .where(eq(forecastedTransactionsTable.id, params.data.id))
    .returning();
  if (!tx) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  res.json(UpdateForecastedTransactionResponse.parse(serialize(tx)));
});

router.delete("/forecast/:id", async (req, res): Promise<void> => {
  const params = DeleteForecastedTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [tx] = await db.delete(forecastedTransactionsTable).where(eq(forecastedTransactionsTable.id, params.data.id)).returning();
  if (!tx) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  res.sendStatus(204);
});

function advanceByFrequency(date: Date, frequency: string): Date {
  const d = new Date(date);
  switch (frequency.toLowerCase()) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": case "bi-weekly": d.setDate(d.getDate() + 14); break;
    case "semi-monthly": case "semimonthly":
      if (d.getDate() < 15) {
        d.setDate(15);
      } else {
        d.setMonth(d.getMonth() + 1);
        d.setDate(1);
      }
      break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "annually": case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d;
}

function serialize(tx: typeof forecastedTransactionsTable.$inferSelect) {
  return {
    ...tx,
    amount: parseFloat(String(tx.amount)),
    createdAt: tx.createdAt.toISOString(),
  };
}

export default router;
