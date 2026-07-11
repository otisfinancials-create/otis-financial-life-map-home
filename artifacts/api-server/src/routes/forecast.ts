import { Router, type IRouter } from "express";
import { eq, and, gte, lt, lte, gt, inArray, isNull, desc } from "drizzle-orm";
import { db, forecastedTransactionsTable, billsTable, paySchedulesTable, lifeEventsTable, userSettingsTable, balanceSyncsTable } from "@workspace/db";
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
  SyncBalanceBody,
  SyncBalanceResponse,
  ListBalanceSyncsResponse,
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
  const created = await regenerateForecastForUser(req.userId);
  res.json(RegenerateForecastResponse.parse({ created, message: `Created ${created} forecasted transactions` }));
});

// Deletes a user's non-actual forecasted transactions and rebuilds them from
// bills, pay schedules, and life events. Returns the number of rows created.
// Exported so one-off scripts can re-seed forecasts for existing users.
export async function regenerateForecastForUser(userId: string): Promise<number> {
  // Delete existing non-actual forecasted transactions for this user.
  // Balance-sync adjustment rows are preserved: they represent a real-world
  // reconciliation, not a projection, so a rebuild must not wipe them out.
  await db.delete(forecastedTransactionsTable).where(
    and(
      eq(forecastedTransactionsTable.isActual, false),
      isNull(forecastedTransactionsTable.sourceBalanceSyncId),
      eq(forecastedTransactionsTable.userId, userId),
    )
  );

  const today = new Date();
  const endDate = new Date(today.getFullYear(), today.getMonth() + 12, 0);
  const toInsert: Array<typeof forecastedTransactionsTable.$inferInsert> = [];

  // All date math below compares YYYY-MM-DD strings (lexicographic order is valid
  // for ISO dates) so results never shift with the local timezone / time of day.
  const todayStr = toLocalIso(today);
  const endStr = toLocalIso(endDate);

  // Generate from bills
  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), eq(billsTable.userId, userId)));

  for (const bill of bills) {
    const amount = parseFloat(String(bill.amount));
    for (const dateStr of generateBillOccurrences(bill, todayStr, endStr)) {
      toInsert.push({
        userId,
        transactionDate: dateStr,
        description: bill.billName,
        amount: String(amount),
        transactionType: "expense",
        category: bill.category,
        sourceBillId: bill.id,
        isActual: false,
        isCommitted: false,
      });
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

  return toInsert.length;
}

// Reconciles the forecasted running balance against the user's real bank
// balance. Records the sync in balance_syncs and, when there is a variance,
// inserts a one-time "Balance Adjustment" row so the running balance
// rebaselines to the actual balance from the sync date forward.
router.post("/forecast/sync-balance", async (req, res): Promise<void> => {
  const parsed = SyncBalanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { actualBalance, syncDate } = parsed.data;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(syncDate)) {
    res.status(400).json({ error: "syncDate must be YYYY-MM-DD" });
    return;
  }
  const now = new Date();
  const todayStr = toLocalIso(now);
  const windowStart = toLocalIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
  if (syncDate > todayStr) {
    res.status(400).json({ error: "Cannot sync a future date — use today or a past date" });
    return;
  }
  if (syncDate < windowStart) {
    res.status(400).json({ error: "Sync date must be within the last 7 days" });
    return;
  }

  // Forecasted balance exactly as shown in the ledger. The ledger anchors the
  // running balance so that today opens at the starting balance, back-filling
  // the 7-day lookback rows — except balance-sync adjustments, which persist
  // through the anchor so they rebaseline the balance forward.
  //   syncDate = today → starting + pastAdj + net(today)
  //   syncDate < today → starting − netNonAdj(syncDate+1..yesterday) + adj(windowStart..syncDate)
  const [settings] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, req.userId));
  const startingBalance = settings ? parseFloat(String(settings.startingBalance)) : 0;

  const rows = await db
    .select({
      transactionDate: forecastedTransactionsTable.transactionDate,
      amount: forecastedTransactionsTable.amount,
      transactionType: forecastedTransactionsTable.transactionType,
      sourceBalanceSyncId: forecastedTransactionsTable.sourceBalanceSyncId,
    })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      gte(forecastedTransactionsTable.transactionDate, windowStart),
      lte(forecastedTransactionsTable.transactionDate, syncDate >= todayStr ? syncDate : todayStr),
    ));

  const signed = (r: typeof rows[number]) => {
    const amt = parseFloat(String(r.amount));
    return r.transactionType === "income" ? amt : -amt;
  };

  let net = 0;
  for (const r of rows) {
    const d = r.transactionDate;
    const isAdj = r.sourceBalanceSyncId != null;
    if (syncDate >= todayStr) {
      // Past adjustments carry through the anchor; then all rows today..syncDate.
      if (d < todayStr) { if (isAdj) net += signed(r); }
      else if (d <= syncDate) net += signed(r);
    } else {
      // Back-filled view: remove non-adjustment net between syncDate and today,
      // keep adjustments dated on or before syncDate.
      if (d > syncDate && d < todayStr && !isAdj) net -= signed(r);
      else if (d <= syncDate && isAdj) net += signed(r);
    }
  }

  const forecastedBalance = Math.round((startingBalance + net) * 100) / 100;
  const variance = Math.round((actualBalance - forecastedBalance) * 100) / 100;

  const sync = await db.transaction(async (tx) => {
    const [syncRow] = await tx.insert(balanceSyncsTable).values({
      userId: req.userId,
      syncDate,
      forecastedBalance: String(forecastedBalance),
      actualBalance: String(actualBalance),
      variance: String(variance),
    }).returning();

    if (variance !== 0) {
      await tx.insert(forecastedTransactionsTable).values({
        userId: req.userId,
        transactionDate: syncDate,
        description: `Balance Adjustment (Synced ${syncDate})`,
        amount: String(Math.abs(variance)),
        transactionType: variance > 0 ? "income" : "expense",
        category: "Adjustment",
        sourceBalanceSyncId: syncRow.id,
        isActual: false,
        isCommitted: true,
      });
    }
    return syncRow;
  });

  req.log.info({ syncDate, variance }, "Balance synced");
  res.status(201).json(SyncBalanceResponse.parse(serializeSync(sync)));
});

router.get("/forecast/balance-syncs", async (req, res): Promise<void> => {
  const syncs = await db
    .select()
    .from(balanceSyncsTable)
    .where(eq(balanceSyncsTable.userId, req.userId))
    .orderBy(desc(balanceSyncsTable.createdAt), desc(balanceSyncsTable.id));
  res.json(ListBalanceSyncsResponse.parse(syncs.map(serializeSync)));
});

function serializeSync(row: typeof balanceSyncsTable.$inferSelect) {
  return {
    id: row.id,
    syncDate: row.syncDate,
    forecastedBalance: parseFloat(String(row.forecastedBalance)),
    actualBalance: parseFloat(String(row.actualBalance)),
    variance: parseFloat(String(row.variance)),
    createdAt: row.createdAt.toISOString(),
  };
}

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
  const [existing] = await db
    .select({ id: forecastedTransactionsTable.id, sourceBalanceSyncId: forecastedTransactionsTable.sourceBalanceSyncId })
    .from(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  if (existing.sourceBalanceSyncId != null) {
    res.status(400).json({ error: "Balance adjustment rows cannot be deleted — they keep the running balance in sync with your bank" });
    return;
  }
  await db
    .delete(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)));
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

// Returns a YYYY-MM-DD string for the given year / 1-based month, clamping the
// day to the month's length so e.g. day 31 in April becomes the 30th and day 31
// in February becomes the 28th/29th (never skipped, never overflowed).
function clampDay(year: number, month1: number, day: number): string {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const d = Math.min(Math.max(day, 1), daysInMonth);
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Adds n calendar days to a YYYY-MM-DD string (UTC, no timezone shift).
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type BillLike = {
  frequency: string;
  dueDay: number;
  startDate: string | null;
  endDate: string | null;
};

// Produces every occurrence date (YYYY-MM-DD) for a bill within the forecast
// window [todayStr, windowEndStr], honoring the bill's own start/end dates.
//
//   - monthly           → anchored on dueDay, clamped to each month's length
//   - weekly / biweekly → stepped in days from the first bill date (startDate)
//   - quarterly         → stepped +3 months from the first bill date
//   - annual            → stepped +12 months from the first bill date
//
// The same start/end-date clamping applies to every frequency, so a bill never
// generates rows before its start date or after its end date.
export function generateBillOccurrences(
  bill: BillLike,
  todayStr: string,
  windowEndStr: string,
): string[] {
  const freq = bill.frequency.toLowerCase();

  // Clamp the generation window to the bill's own start/end dates.
  const startBoundary =
    bill.startDate && bill.startDate > todayStr ? bill.startDate : todayStr;
  const endBoundary =
    bill.endDate && bill.endDate < windowEndStr ? bill.endDate : windowEndStr;
  if (startBoundary > endBoundary) return [];

  const out: string[] = [];
  const MAX = 2000; // safety guard against pathological inputs

  if (freq === "monthly") {
    let y = Number(startBoundary.slice(0, 4));
    let m = Number(startBoundary.slice(5, 7));
    for (let i = 0; i < MAX; i++) {
      const occ = clampDay(y, m, bill.dueDay);
      if (occ > endBoundary) break;
      if (occ >= startBoundary) out.push(occ);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Date-driven frequencies. Seed from the first bill date when set; otherwise
  // fall back to dueDay in today's month for legacy rows without a start date.
  const seed =
    bill.startDate ??
    clampDay(Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)), bill.dueDay);

  const step = (iso: string): string => {
    switch (freq) {
      case "weekly": return addDaysIso(iso, 7);
      case "biweekly": case "bi-weekly": return addDaysIso(iso, 14);
      case "quarterly": return addMonthsIso(iso, 3);
      case "annual": case "annually": case "yearly": return addMonthsIso(iso, 12);
      default: return addMonthsIso(iso, 1);
    }
  };

  let current = seed;
  let guard = 0;
  while (current < startBoundary && guard++ < MAX) current = step(current);
  guard = 0;
  while (current <= endBoundary && guard++ < MAX) {
    out.push(current);
    current = step(current);
  }
  return out;
}

function serialize(tx: typeof forecastedTransactionsTable.$inferSelect) {
  return {
    ...tx,
    amount: parseFloat(String(tx.amount)),
    createdAt: tx.createdAt.toISOString(),
  };
}

export default router;
