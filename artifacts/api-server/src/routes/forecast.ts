import { Router, type IRouter } from "express";
import { eq, and, or, gte, lt, lte, gt, inArray, isNull, desc } from "drizzle-orm";
import { db, forecastedTransactionsTable, billsTable, paySchedulesTable, lifeEventsTable, userSettingsTable, balanceSyncsTable, accountsTable } from "@workspace/db";
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
    // Balance-update override rows are balance values, not cash flows; missed
    // rows never happened — both are excluded from monthly totals.
    if (row.sourceBalanceSyncId != null || row.status === "missed") continue;
    // CC parent rows are payment aggregators — their children already carry
    // the expense amounts, so counting the parent would double-count.
    if (row.isCcParent) continue;
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
  // Delete existing non-actual forecasted transactions for this user, from
  // today forward only. Preserved rows:
  //   - Balance-update rows (real-world reconciliations, not projections)
  //   - Past rows (paid, missed, or still pending) — they are the 30-day
  //     rolling history and must survive a rebuild.
  //   - User-committed rows (isCommitted) — manual entries and rows the user
  //     has edited. Wiping these was the "forecast edits don't persist" bug:
  //     any bill/loan/life-event change triggers a background regenerate,
  //     which used to delete every future non-paid row including user edits.
  const regenTodayStr = toLocalIso(new Date());
  await db.delete(forecastedTransactionsTable).where(
    and(
      eq(forecastedTransactionsTable.isActual, false),
      eq(forecastedTransactionsTable.isCommitted, false),
      isNull(forecastedTransactionsTable.sourceBalanceSyncId),
      gte(forecastedTransactionsTable.transactionDate, regenTodayStr),
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

  // Credit-card billing cycle grouping (manual version — Plaid will automate
  // this in a future phase). Bills paid by a configured credit card do NOT
  // appear on their own due dates; instead each occurrence is grouped under a
  // "Credit Card Payment" parent row on the card's payment due date.
  const ccAccounts = await db
    .select()
    .from(accountsTable)
    .where(and(
      eq(accountsTable.userId, userId),
      eq(accountsTable.accountType, "credit_card"),
    ));
  const ccByName = new Map<string, typeof ccAccounts[number]>();
  for (const acct of ccAccounts) {
    if (acct.ccCycleStartDate != null && acct.ccCycleEndDate != null && acct.ccPaymentDueDate != null) {
      ccByName.set(acct.accountName.trim().toLowerCase(), acct);
    }
  }

  // groups: key = `${accountId}|${dueDateStr}` → child rows for that CC payment
  const ccGroups = new Map<string, { account: typeof ccAccounts[number]; dueDate: string; children: Array<typeof forecastedTransactionsTable.$inferInsert> }>();

  // Paid (actual) and user-committed rows survive the delete above, but
  // generated parent/sibling rows do not. Track the survivors so we
  // (a) don't insert duplicate occurrences for rows that already exist, and
  // (b) recreate each CC group's parent with the correct paid amount.
  const preservedRows = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.isCcParent, false),
      isNull(forecastedTransactionsTable.sourceBalanceSyncId),
      gte(forecastedTransactionsTable.transactionDate, regenTodayStr),
      or(
        eq(forecastedTransactionsTable.isActual, true),
        eq(forecastedTransactionsTable.isCommitted, true),
      ),
    ));
  const survivorsByGroup = new Map<string, number>(); // key → paid sum
  const survivorOccurrences = new Set<string>(); // `${sourceBillId}|${dueDate}` (CC children)
  // Non-CC preserved occurrences: `bill|id|date`, `pay|id|date`, `life|id|date`
  const preservedKeys = new Set<string>();
  for (const row of preservedRows) {
    if (row.ccAccountId != null) {
      const key = `${row.ccAccountId}|${row.transactionDate}`;
      if (row.isActual && row.status !== "missed") {
        survivorsByGroup.set(key, (survivorsByGroup.get(key) ?? 0) + parseFloat(String(row.amount)));
      }
      if (row.sourceBillId != null) {
        survivorOccurrences.add(`${row.sourceBillId}|${row.transactionDate}`);
      }
    } else {
      if (row.sourceBillId != null) preservedKeys.add(`bill|${row.sourceBillId}|${row.transactionDate}`);
      if (row.sourcePayId != null) preservedKeys.add(`pay|${row.sourcePayId}|${row.transactionDate}`);
      if (row.sourceLifeEventId != null) preservedKeys.add(`life|${row.sourceLifeEventId}|${row.transactionDate}`);
    }
  }

  for (const bill of bills) {
    const amount = parseFloat(String(bill.amount));
    const cardName = bill.paymentMethod?.startsWith("credit-card:")
      ? bill.paymentMethod.slice("credit-card:".length).trim().toLowerCase()
      : null;
    const card = cardName ? ccByName.get(cardName) : undefined;

    for (const dateStr of generateBillOccurrences(bill, todayStr, endStr)) {
      if (card) {
        const dueDate = ccPaymentDueDateFor(dateStr, card.ccCycleEndDate!, card.ccPaymentDueDate!);
        const key = `${card.id}|${dueDate}`;
        let group = ccGroups.get(key);
        if (!group) {
          group = { account: card, dueDate, children: [] };
          ccGroups.set(key, group);
        }
        // A paid (actual) row for this occurrence already exists — keep it,
        // don't insert a duplicate forecasted child.
        if (survivorOccurrences.has(`${bill.id}|${dueDate}`)) continue;
        group.children.push({
          userId,
          transactionDate: dueDate,
          description: bill.billName,
          amount: String(amount),
          transactionType: bill.amountType === "positive" ? "income" : "expense",
          category: bill.category,
          sourceBillId: bill.id,
          ccAccountId: card.id,
          isCcParent: false,
          isActual: false,
          isCommitted: false,
        });
      } else {
        // A preserved (paid or user-edited) row already covers this
        // occurrence — don't insert a duplicate.
        if (preservedKeys.has(`bill|${bill.id}|${dateStr}`)) continue;
        toInsert.push({
          userId,
          transactionDate: dateStr,
          description: bill.billName,
          amount: String(amount),
          transactionType: bill.amountType === "positive" ? "income" : "expense",
          category: bill.category,
          sourceBillId: bill.id,
          isActual: false,
          isCommitted: false,
        });
      }
    }
  }

  // Emit one parent "Credit Card Payment" row per CC group (starts at $0;
  // increments as children are marked paid), followed by its children. Only
  // future-dated groups are emitted (past rows were preserved above).
  // Ensure groups that now consist solely of surviving paid children still get
  // a parent row recreated.
  for (const [key, paidSum] of survivorsByGroup) {
    if (ccGroups.has(key)) continue;
    const [acctIdStr, dueDate] = key.split("|");
    const account = ccAccounts.find((a) => a.id === Number(acctIdStr));
    if (account) ccGroups.set(key, { account, dueDate, children: [] });
    void paidSum;
  }

  for (const [key, group] of ccGroups) {
    if (group.dueDate < todayStr || group.dueDate > endStr) continue;
    const paidSum = survivorsByGroup.get(key) ?? 0;
    toInsert.push({
      userId,
      transactionDate: group.dueDate,
      description: `Credit Card Payment — ${group.account.accountName}`,
      amount: String(Math.round(paidSum * 100) / 100),
      transactionType: "expense",
      category: "debt_payments",
      ccAccountId: group.account.id,
      isCcParent: true,
      isActual: false,
      isCommitted: false,
      sortOrder: 0,
    });
    group.children.forEach((child, i) => {
      toInsert.push({ ...child, sortOrder: i + 1 });
    });
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
      if (current >= today && !preservedKeys.has(`pay|${ps.id}|${current.toISOString().split("T")[0]}`)) {
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
      if (preservedKeys.has(`life|${ev.id}|${dateStr}`)) return;
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
      let guard = 0;
      while (current <= recurEndStr && guard < 5000) {
        if (current >= todayStr) {
          pushRow(current, total, ev.eventName);
        }
        current = advanceIsoByFrequency(current, frequency, ev.customIntervalDays);
        guard++;
      }
    }
  }

  if (toInsert.length > 0) {
    await db.insert(forecastedTransactionsTable).values(toInsert);
  }

  return toInsert.length;
}

// "Update Current Balance": reconciles the forecast against the user's real
// bank balance. Records the update in balance_syncs and inserts (or replaces)
// a "Balance Update — [date]" override row that is always the FIRST row for
// its date. The override row's amount IS the entered balance — the ledger sets
// the running balance to this value at that row and calculates forward from it.
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
  const windowStart = toLocalIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
  if (syncDate > todayStr) {
    res.status(400).json({ error: "Cannot update the balance for a future date — use today or a past date" });
    return;
  }
  if (syncDate < windowStart) {
    res.status(400).json({ error: "Balance update date must be within the last 30 days" });
    return;
  }

  // Forecasted balance = the displayed running balance at the START of
  // syncDate (before any of that day's rows), mirroring the ledger math:
  //   - If a balance-update row exists before syncDate, roll forward from the
  //     latest one (its amount is the balance at that row).
  //   - Else if one exists on/after syncDate (≤ today), roll backward from the
  //     earliest such row.
  //   - Else anchor on user_settings.startingBalance = balance at start of
  //     today, back-filling any lookback rows between syncDate and today.
  // Missed rows (status = 'missed') never affect the balance.
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
      status: forecastedTransactionsTable.status,
    })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      gte(forecastedTransactionsTable.transactionDate, windowStart),
      lte(forecastedTransactionsTable.transactionDate, todayStr),
    ));

  const signed = (r: typeof rows[number]) => {
    const amt = parseFloat(String(r.amount));
    return r.transactionType === "income" ? amt : -amt;
  };
  // Overrides on syncDate itself are being replaced by this update, so ignore them.
  const overrides = rows
    .filter((r) => r.sourceBalanceSyncId != null && r.transactionDate !== syncDate)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  const flows = rows.filter((r) => r.sourceBalanceSyncId == null && r.status !== "missed");

  const before = overrides.filter((o) => o.transactionDate < syncDate).at(-1);
  const after = overrides.find((o) => o.transactionDate >= syncDate);

  let bal: number;
  if (before) {
    bal = parseFloat(String(before.amount)) + flows
      .filter((r) => r.transactionDate >= before.transactionDate && r.transactionDate < syncDate)
      .reduce((s, r) => s + signed(r), 0);
  } else if (after) {
    bal = parseFloat(String(after.amount)) - flows
      .filter((r) => r.transactionDate >= syncDate && r.transactionDate < after.transactionDate)
      .reduce((s, r) => s + signed(r), 0);
  } else {
    bal = startingBalance - flows
      .filter((r) => r.transactionDate >= syncDate && r.transactionDate < todayStr)
      .reduce((s, r) => s + signed(r), 0);
  }

  const forecastedBalance = Math.round(bal * 100) / 100;
  const variance = Math.round((actualBalance - forecastedBalance) * 100) / 100;

  const sync = await db.transaction(async (tx) => {
    const [syncRow] = await tx.insert(balanceSyncsTable).values({
      userId: req.userId,
      syncDate,
      forecastedBalance: String(forecastedBalance),
      actualBalance: String(actualBalance),
      variance: String(variance),
    }).returning();

    // Replace any existing balance-update row on this date, then insert the
    // new override row positioned AFTER the paid (actual) transactions on the
    // date but BEFORE any unpaid ones — the override becomes the running
    // balance baseline and unpaid rows calculate forward from it.
    await tx.delete(forecastedTransactionsTable).where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      eq(forecastedTransactionsTable.transactionDate, syncDate),
      gt(forecastedTransactionsTable.sourceBalanceSyncId, 0),
    ));

    const sameDay = await tx
      .select({
        id: forecastedTransactionsTable.id,
        isActual: forecastedTransactionsTable.isActual,
        sortOrder: forecastedTransactionsTable.sortOrder,
      })
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.userId, req.userId),
        eq(forecastedTransactionsTable.transactionDate, syncDate),
      ))
      .orderBy(forecastedTransactionsTable.sortOrder, forecastedTransactionsTable.id);

    // Re-number the day: paid rows keep their order first, then the override,
    // then unpaid rows in their existing order.
    const paid = sameDay.filter((r) => r.isActual);
    const unpaid = sameDay.filter((r) => !r.isActual);
    let order = 0;
    for (const r of paid) {
      await tx.update(forecastedTransactionsTable)
        .set({ sortOrder: order++ })
        .where(and(eq(forecastedTransactionsTable.id, r.id), eq(forecastedTransactionsTable.userId, req.userId)));
    }
    const overrideSortOrder = order++;
    for (const r of unpaid) {
      await tx.update(forecastedTransactionsTable)
        .set({ sortOrder: order++ })
        .where(and(eq(forecastedTransactionsTable.id, r.id), eq(forecastedTransactionsTable.userId, req.userId)));
    }

    await tx.insert(forecastedTransactionsTable).values({
      userId: req.userId,
      transactionDate: syncDate,
      description: `Balance Update — ${syncDate}`,
      amount: String(actualBalance),
      transactionType: "income",
      category: "Balance Update",
      sourceBalanceSyncId: syncRow.id,
      isActual: false,
      isCommitted: true,
      sortOrder: overrideSortOrder,
    });

    // Updating today's balance also becomes the new starting balance so the
    // banner and settings stay coherent with the ledger.
    if (syncDate === todayStr) {
      await tx.insert(userSettingsTable).values({
        userId: req.userId,
        startingBalance: String(actualBalance),
        balanceAsOfDate: todayStr,
      }).onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { startingBalance: String(actualBalance), balanceAsOfDate: todayStr },
      });
    }
    return syncRow;
  });

  req.log.info({ syncDate, variance }, "Balance updated");
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
    .select({
      id: forecastedTransactionsTable.id,
      transactionDate: forecastedTransactionsTable.transactionDate,
      sourceBalanceSyncId: forecastedTransactionsTable.sourceBalanceSyncId,
    })
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
  if (owned.some((r) => r.sourceBalanceSyncId != null)) {
    res.status(400).json({ error: "Balance Update rows cannot be reordered" });
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
  const [existing] = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }

  if (existing.sourceBalanceSyncId != null) {
    res.status(400).json({ error: "Balance update rows cannot be edited — run Update Current Balance again to correct them" });
    return;
  }

  const { amount: rawTxAmount, forecastedAmount: rawForecastedAmount, applyToFuture, ...restTxData } = parsed.data;

  // Future-dated rows cannot be marked as paid (TC-F12).
  const todayStr = toLocalIso(new Date());
  const effectiveDate = restTxData.transactionDate ?? existing.transactionDate;
  if (restTxData.isActual === true && effectiveDate > todayStr) {
    res.status(400).json({
      error: `This transaction is scheduled for ${effectiveDate}. To mark it as paid, please update the date to today or an earlier date first.`,
    });
    return;
  }

  const set = {
    ...restTxData,
    ...(rawTxAmount !== undefined && { amount: String(rawTxAmount) }),
    ...(rawForecastedAmount !== undefined && { forecastedAmount: rawForecastedAmount === null ? null : String(rawForecastedAmount) }),
    // Any user edit commits the row so forecast regeneration preserves it
    // (CC parent rows stay uncommitted — they are always derived).
    ...(!existing.isCcParent && { isCommitted: true }),
  };

  const tx = await db.transaction(async (trx) => {
    const [updated] = await trx
      .update(forecastedTransactionsTable)
      .set(set)
      .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)))
      .returning();

    // CC group behavior: the "Credit Card Payment" parent row's amount is
    // always the sum of its PAID children (that sum is what actually hits the
    // running balance). Recompute it deterministically after any child
    // mutation — paid toggles, amount edits, or date moves (old + new group).
    // Plaid will automate this in a future phase — this is the manual version.
    if (existing.ccAccountId != null && !existing.isCcParent) {
      await recomputeCcParent(trx, req.userId, existing.ccAccountId, existing.transactionDate);
      if (updated.transactionDate !== existing.transactionDate) {
        await recomputeCcParent(trx, req.userId, existing.ccAccountId, updated.transactionDate);
      }
    }

    // Recurring rows: optionally apply description/category/amount to all
    // future, not-yet-paid occurrences of the same bill or paycheck.
    if (applyToFuture && (existing.sourceBillId != null || existing.sourcePayId != null)) {
      const futureSet: Partial<typeof forecastedTransactionsTable.$inferInsert> = {};
      if (restTxData.description !== undefined) futureSet.description = restTxData.description;
      if (restTxData.category !== undefined) futureSet.category = restTxData.category;
      if (rawTxAmount !== undefined) futureSet.amount = String(rawTxAmount);
      if (Object.keys(futureSet).length > 0) {
        // Commit these rows too so regeneration preserves the applied edits.
        futureSet.isCommitted = true;
        await trx
          .update(forecastedTransactionsTable)
          .set(futureSet)
          .where(and(
            eq(forecastedTransactionsTable.userId, req.userId),
            eq(forecastedTransactionsTable.isActual, false),
            gt(forecastedTransactionsTable.transactionDate, existing.transactionDate),
            existing.sourceBillId != null
              ? eq(forecastedTransactionsTable.sourceBillId, existing.sourceBillId)
              : eq(forecastedTransactionsTable.sourcePayId, existing.sourcePayId!),
          ));
      }
    }
    return updated;
  });

  res.json(UpdateForecastedTransactionResponse.parse(serialize(tx)));
});

router.delete("/forecast/:id", async (req, res): Promise<void> => {
  const params = DeleteForecastedTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existing] = await db
    .select({
      id: forecastedTransactionsTable.id,
      sourceBalanceSyncId: forecastedTransactionsTable.sourceBalanceSyncId,
      ccAccountId: forecastedTransactionsTable.ccAccountId,
      isCcParent: forecastedTransactionsTable.isCcParent,
      transactionDate: forecastedTransactionsTable.transactionDate,
    })
    .from(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  if (existing.sourceBalanceSyncId != null) {
    res.status(400).json({ error: "Balance update rows cannot be deleted — they keep the running balance in sync with your bank" });
    return;
  }
  await db.transaction(async (trx) => {
    await trx
      .delete(forecastedTransactionsTable)
      .where(and(eq(forecastedTransactionsTable.id, params.data.id), eq(forecastedTransactionsTable.userId, req.userId)));
    if (existing.ccAccountId != null) {
      if (existing.isCcParent) {
        // Deleting a parent orphans its children — remove the whole group.
        await trx.delete(forecastedTransactionsTable).where(and(
          eq(forecastedTransactionsTable.userId, req.userId),
          eq(forecastedTransactionsTable.ccAccountId, existing.ccAccountId),
          eq(forecastedTransactionsTable.isCcParent, false),
          eq(forecastedTransactionsTable.transactionDate, existing.transactionDate),
        ));
      } else {
        await recomputeCcParent(trx, req.userId, existing.ccAccountId, existing.transactionDate);
      }
    }
  });
  res.sendStatus(204);
});

// Sets a CC group's "Credit Card Payment" parent amount to the sum of its
// PAID (isActual) children on the same date. Deterministic: safe to call after
// any child mutation. No-op if the group has no parent row.
async function recomputeCcParent(
  trx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  ccAccountId: number,
  dateStr: string,
): Promise<void> {
  const children = await trx
    .select({ amount: forecastedTransactionsTable.amount, isActual: forecastedTransactionsTable.isActual, status: forecastedTransactionsTable.status })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.ccAccountId, ccAccountId),
      eq(forecastedTransactionsTable.isCcParent, false),
      eq(forecastedTransactionsTable.transactionDate, dateStr),
    ));
  const total = children
    .filter((c) => c.isActual && c.status !== "missed")
    .reduce((sum, c) => sum + parseFloat(String(c.amount)), 0);
  await trx
    .update(forecastedTransactionsTable)
    .set({ amount: String(Math.round(total * 100) / 100) })
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.ccAccountId, ccAccountId),
      eq(forecastedTransactionsTable.isCcParent, true),
      eq(forecastedTransactionsTable.transactionDate, dateStr),
    ));
}

// Given a bill occurrence date within a CC billing cycle, returns the card's
// payment due date (YYYY-MM-DD) for the cycle that occurrence falls in: the
// first ccPaymentDueDate strictly after the cycle end that covers the
// occurrence. Cycle end day is clamped per month (e.g. day 31 in Feb → 28/29).
function ccPaymentDueDateFor(occurrenceIso: string, cycleEndDay: number, paymentDueDay: number): string {
  const y = Number(occurrenceIso.slice(0, 4));
  const m = Number(occurrenceIso.slice(5, 7));
  // Cycle end on/after the occurrence (this month, else next month).
  let cycleEnd = clampDay(y, m, cycleEndDay);
  if (cycleEnd < occurrenceIso) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    cycleEnd = clampDay(ny, nm, cycleEndDay);
  }
  // Payment due date strictly after the cycle end.
  const ey = Number(cycleEnd.slice(0, 4));
  const em = Number(cycleEnd.slice(5, 7));
  let due = clampDay(ey, em, paymentDueDay);
  if (due <= cycleEnd) {
    const nm = em === 12 ? 1 : em + 1;
    const ny = em === 12 ? ey + 1 : ey;
    due = clampDay(ny, nm, paymentDueDay);
  }
  return due;
}

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

function advanceIsoByFrequency(iso: string, frequency: string, customIntervalDays?: number | null): string {
  switch (frequency.toLowerCase()) {
    case "monthly": return addMonthsIso(iso, 1);
    case "quarterly": return addMonthsIso(iso, 3);
    case "biannually": case "bi-annually": case "semi-annual": case "semiannual": case "biannual": return addMonthsIso(iso, 6);
    case "annual": case "annually": case "yearly": return addMonthsIso(iso, 12);
    case "custom": return addDaysIso(iso, customIntervalDays && customIntervalDays > 0 ? customIntervalDays : 30);
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
    forecastedAmount: tx.forecastedAmount == null ? null : parseFloat(String(tx.forecastedAmount)),
    createdAt: tx.createdAt.toISOString(),
  };
}

export default router;
