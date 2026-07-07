import { Router, type IRouter } from "express";
import { eq, and, gte, lt, inArray } from "drizzle-orm";
import { db, forecastedTransactionsTable, billsTable, paySchedulesTable, lifeEventsTable } from "@workspace/db";
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
  ReorderForecastBody,
  ReorderForecastResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/forecast", async (req, res): Promise<void> => {
  const queryParams = ListForecastQueryParams.safeParse(req.query);
  if (!queryParams.success) {
    res.status(400).json({ error: queryParams.error.message });
    return;
  }

  const conditions = [eq(forecastedTransactionsTable.userId, req.userId)];

  if (queryParams.data.startDate) {
    conditions.push(gte(forecastedTransactionsTable.transactionDate, queryParams.data.startDate));
  }
  if (queryParams.data.endDate) {
    conditions.push(lt(forecastedTransactionsTable.transactionDate, queryParams.data.endDate));
  }

  const rows = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(...conditions))
    .orderBy(
      forecastedTransactionsTable.transactionDate,
      forecastedTransactionsTable.sortOrder,
      forecastedTransactionsTable.id,
    );

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
    userId: req.userId,
    amount: String(parsed.data.amount),
    isActual: parsed.data.isActual ?? false,
    isCommitted: parsed.data.isCommitted ?? false,
  }).returning();
  res.status(201).json(CreateForecastedTransactionResponse.parse(serialize(tx)));
});

router.get("/forecast/monthly", async (req, res): Promise<void> => {
  const today = new Date();
  const rows = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(eq(forecastedTransactionsTable.userId, req.userId));

  const monthlyMap: Record<string, { month: number; year: number; label: string; totalIncome: number; totalExpenses: number; totalLifeEvents: number }> = {};

  for (let i = 0; i < 12; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = {
      month: d.getMonth() + 1,
      year: d.getFullYear(),
      label: d.toLocaleString("en-US", { month: "short", year: "numeric" }),
      totalIncome: 0,
      totalExpenses: 0,
      totalLifeEvents: 0,
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
      // Life-event costs remain part of totalExpenses (so netCashFlow is correct)
      // but are also tracked separately so the UI can break them out.
      monthlyMap[key].totalExpenses += amount;
      if (row.sourceLifeEventId != null) {
        monthlyMap[key].totalLifeEvents += amount;
      }
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
  const userId = req.userId;

  // Delete existing non-actual forecasted transactions for this user
  await db.delete(forecastedTransactionsTable).where(
    and(
      eq(forecastedTransactionsTable.isActual, false),
      eq(forecastedTransactionsTable.userId, userId),
    )
  );

  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth() + 12, 0);
  const toInsert: Array<typeof forecastedTransactionsTable.$inferInsert> = [];

  // Generate from bills
  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), eq(billsTable.userId, userId)));

  for (const bill of bills) {
    const amount = parseFloat(String(bill.amount));
    const frequency = bill.frequency;

    let current = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (current < today) {
      current = advanceByFrequency(current, frequency);
    }

    while (current <= endDate) {
      toInsert.push({
        userId,
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
  const paySchedules = await db
    .select()
    .from(paySchedulesTable)
    .where(eq(paySchedulesTable.userId, userId));

  for (const ps of paySchedules) {
    const amount = parseFloat(String(ps.amount));
    let current = new Date(ps.nextPayDate);

    while (current <= endDate) {
      if (current >= today) {
        toInsert.push({
          userId,
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

  // Generate from life events
  const lifeEvents = await db
    .select()
    .from(lifeEventsTable)
    .where(and(eq(lifeEventsTable.isActive, true), eq(lifeEventsTable.userId, userId)));

  // Compare life-event dates as YYYY-MM-DD strings (not Date objects) so that
  // same-day events are included regardless of the current time of day, and use
  // clamped month stepping so month-end starts (e.g. Jan 31) never skip a month.
  const todayStr = toLocalIso(today);
  const endStr = toLocalIso(endDate);

  for (const ev of lifeEvents) {
    const total = parseFloat(String(ev.amount));
    const category = ev.category === "custom" && ev.customCategory ? ev.customCategory : ev.category;

    const pushRow = (dateStr: string, amount: number, description: string) => {
      toInsert.push({
        userId,
        transactionDate: dateStr,
        description,
        amount: String(Math.round(amount * 100) / 100),
        transactionType: "expense",
        category,
        sourceLifeEventId: ev.id,
        isActual: false,
        isCommitted: false,
      });
    };

    if (ev.timingType === "one_time" && ev.eventDate) {
      if (ev.eventDate >= todayStr && ev.eventDate <= endStr) {
        pushRow(ev.eventDate, total, ev.eventName);
      }
    } else if (ev.timingType === "spread" && ev.startDate && ev.endDate) {
      const [sy, sm] = ev.startDate.split("-").map(Number);
      const [ey, em] = ev.endDate.split("-").map(Number);
      const months = (ey - sy) * 12 + (em - sm) + 1;
      if (months > 0) {
        const perMonth = total / months;
        let current = ev.startDate;
        for (let i = 0; i < months; i++) {
          if (current >= todayStr && current <= endStr) {
            pushRow(current, perMonth, `${ev.eventName} (${i + 1}/${months})`);
          }
          current = addMonthsIso(current, 1);
        }
      }
    } else if (ev.timingType === "recurring" && ev.startDate) {
      const frequency = ev.frequency ?? "annually";
      const recurEndStr = ev.endDate && ev.endDate < endStr ? ev.endDate : endStr;
      let current = ev.startDate;
      while (current <= recurEndStr) {
        if (current >= todayStr) {
          pushRow(current, total, ev.eventName);
        }
        current = advanceIsoByFrequency(current, frequency);
      }
    }
  }

  if (toInsert.length > 0) {
    await db.insert(forecastedTransactionsTable).values(toInsert);
  }

  res.json(RegenerateForecastResponse.parse({ created: toInsert.length, message: `Created ${toInsert.length} forecasted transactions` }));
});

router.post("/forecast/reorder", async (req, res): Promise<void> => {
  const parsed = ReorderForecastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ids } = parsed.data;
  if (ids.length === 0) {
    res.json(ReorderForecastResponse.parse({ updated: 0 }));
    return;
  }
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "Duplicate transaction ids" });
    return;
  }

  const owned = await db
    .select({ id: forecastedTransactionsTable.id, transactionDate: forecastedTransactionsTable.transactionDate })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      inArray(forecastedTransactionsTable.id, ids),
    ));
  const ownedIds = new Set(owned.map((r) => r.id));
  if (ownedIds.size !== ids.length || ids.some((id) => !ownedIds.has(id))) {
    res.status(404).json({ error: "One or more transactions not found" });
    return;
  }
  if (new Set(owned.map((r) => r.transactionDate)).size > 1) {
    res.status(400).json({ error: "All transactions must share the same date" });
    return;
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(forecastedTransactionsTable)
        .set({ sortOrder: i })
        .where(and(
          eq(forecastedTransactionsTable.id, ids[i]),
          eq(forecastedTransactionsTable.userId, req.userId),
        ));
    }
  });

  res.json(ReorderForecastResponse.parse({ updated: ids.length }));
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
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)))
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
  const [tx] = await db
    .delete(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)))
    .returning();
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
    case "semi-annual": case "semiannual": case "biannual": d.setMonth(d.getMonth() + 6); break;
    case "annual": case "annually": case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d;
}

// Local YYYY-MM-DD (no timezone shift) for string-based date comparisons.
function toLocalIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Adds months to a YYYY-MM-DD string, clamping the day to the target month's
// length so month-end dates (e.g. Jan 31 + 1mo) never overflow into a later month.
function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

function advanceIsoByFrequency(iso: string, frequency: string): string {
  switch (frequency.toLowerCase()) {
    case "monthly": return addMonthsIso(iso, 1);
    case "quarterly": return addMonthsIso(iso, 3);
    case "annual": case "annually": case "yearly": return addMonthsIso(iso, 12);
    default: return addMonthsIso(iso, 12);
  }
}

function serialize(tx: typeof forecastedTransactionsTable.$inferSelect) {
  return {
    ...tx,
    amount: parseFloat(String(tx.amount)),
    createdAt: tx.createdAt.toISOString(),
  };
}

export default router;
