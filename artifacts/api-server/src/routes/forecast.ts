import { Router, type IRouter } from "express";
import { eq, ne, and, or, gte, lt, lte, gt, inArray, isNull, isNotNull, desc } from "drizzle-orm";
import { db, forecastedTransactionsTable, billsTable, paySchedulesTable, lifeEventsTable, userSettingsTable, balanceSyncsTable, accountsTable, cardCyclesTable, billMatchDismissalsTable } from "@workspace/db";
import { findReconcileSuggestions } from "../services/bill-reconciliation";
import { rollActualsForUser } from "../services/actuals-roll";
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
  GetForecastCalendarQueryParams,
  GetForecastCalendarResponse,
  ReconcileForecastedTransactionBody,
  AnchorForecastBody,
} from "@workspace/api-zod";
import { plaidTransactionsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/forecast", async (req, res): Promise<void> => {
  const queryParams = ListForecastQueryParams.safeParse(req.query);
  if (!queryParams.success) {
    res.status(400).json({ error: queryParams.error.message });
    return;
  }

  const conditions = [
    eq(forecastedTransactionsTable.userId, req.userId),
    // "Didn't happen" rows are removed from the ledger entirely (kept in the
    // DB only so regeneration doesn't re-emit the occurrence).
    or(isNull(forecastedTransactionsTable.status), ne(forecastedTransactionsTable.status, "removed"))!,
  ];

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
    if (row.sourceBalanceSyncId != null || row.status === "missed" || row.status === "removed") continue;
    // Legacy CC parent rows are payment aggregators — their children already
    // carry the expense amounts, so counting the parent would double-count.
    // Cycle-based payments (sourceCardCycleId) have NO children: the parent
    // IS the cash event and must count exactly once.
    if (row.isCcParent && row.sourceCardCycleId == null) continue;
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

/**
 * Hybrid month calendar (Phase 1 — existing data only).
 * Future days (>= today) show the plan from forecasted_transactions; past
 * days show posted Plaid actuals on cash accounts (non-bill spend bucketed by
 * category). End-of-day balances roll forward from the ledger balance at the
 * start of the month, re-anchoring at balance-update rows.
 */
router.get("/forecast/calendar", async (req, res): Promise<void> => {
  const parsed = GetForecastCalendarQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const month = parsed.data.month;
  const [yStr, mStr] = month.split("-");
  const year = Number(yStr);
  const mon = Number(mStr); // 1-based
  if (mon < 1 || mon > 12) {
    res.status(400).json({ error: "Invalid month" });
    return;
  }
  const daysInMonth = new Date(year, mon, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const todayStr = toLocalIso(new Date());

  type Ev = {
    kind: "income" | "bill" | "card-payment" | "spend" | "balance-update" | "other";
    label: string;
    amount: number;
    cycleId?: number | null;
    category?: string | null;
    count?: number | null;
    charges?: Array<{ date: string; name: string; amount: number }> | null;
  };
  const eventsByDate = new Map<string, Ev[]>();
  const push = (date: string, ev: Ev) => {
    const list = eventsByDate.get(date) ?? [];
    list.push(ev);
    eventsByDate.set(date, list);
  };
  const cents = (n: number) => Math.round(n * 100) / 100;

  // All forecast rows (minimal columns) — needed both for the month's plan
  // days and for anchoring the start-of-month balance.
  const fRows = await db
    .select({
      transactionDate: forecastedTransactionsTable.transactionDate,
      description: forecastedTransactionsTable.description,
      amount: forecastedTransactionsTable.amount,
      transactionType: forecastedTransactionsTable.transactionType,
      category: forecastedTransactionsTable.category,
      sourceBalanceSyncId: forecastedTransactionsTable.sourceBalanceSyncId,
      sourceCardCycleId: forecastedTransactionsTable.sourceCardCycleId,
      sourceBillId: forecastedTransactionsTable.sourceBillId,
      ccAccountId: forecastedTransactionsTable.ccAccountId,
      isCcParent: forecastedTransactionsTable.isCcParent,
      status: forecastedTransactionsTable.status,
      sortOrder: forecastedTransactionsTable.sortOrder,
    })
    .from(forecastedTransactionsTable)
    .where(eq(forecastedTransactionsTable.userId, req.userId))
    .orderBy(
      forecastedTransactionsTable.transactionDate,
      forecastedTransactionsTable.sortOrder,
      forecastedTransactionsTable.id,
    );
  type FRow = (typeof fRows)[number];
  const isOverride = (r: FRow) => r.sourceBalanceSyncId != null;
  const isCcChild = (r: FRow) => r.ccAccountId != null && !r.isCcParent;
  const countsForBalance = (r: FRow) => !isOverride(r) && !isCcChild(r) && r.status !== "missed" && r.status !== "removed";
  const signedF = (r: FRow) => {
    const amt = parseFloat(String(r.amount));
    return r.transactionType === "income" ? amt : -amt;
  };

  // Ledger balance at the START of monthStart, mirroring sync-balance math:
  // roll forward from the latest override before it, else backward from the
  // earliest one after, else anchor startingBalance at the start of today.
  const [settings] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, req.userId));
  const startingBalance = settings ? parseFloat(String(settings.startingBalance)) : 0;
  const overrides = fRows.filter(isOverride);
  const flows = fRows.filter(countsForBalance);
  const before = overrides.filter((o) => o.transactionDate < monthStart).at(-1);
  const after = overrides.find((o) => o.transactionDate >= monthStart);
  let startBalance: number;
  if (before) {
    startBalance =
      parseFloat(String(before.amount)) +
      flows
        .filter((r) => r.transactionDate >= before.transactionDate && r.transactionDate < monthStart)
        .reduce((s, r) => s + signedF(r), 0);
  } else if (after) {
    startBalance =
      parseFloat(String(after.amount)) -
      flows
        .filter((r) => r.transactionDate >= monthStart && r.transactionDate < after.transactionDate)
        .reduce((s, r) => s + signedF(r), 0);
  } else if (monthStart <= todayStr) {
    startBalance =
      startingBalance -
      flows
        .filter((r) => r.transactionDate >= monthStart && r.transactionDate < todayStr)
        .reduce((s, r) => s + signedF(r), 0);
  } else {
    startBalance =
      startingBalance +
      flows
        .filter((r) => r.transactionDate >= todayStr && r.transactionDate < monthStart)
        .reduce((s, r) => s + signedF(r), 0);
  }

  // PLAN — today and future days of the month, from forecasted rows.
  for (const r of fRows) {
    if (r.transactionDate < monthStart || r.transactionDate > monthEnd) continue;
    if (r.transactionDate < todayStr) {
      // Past: only balance-update anchors are surfaced from the plan side.
      if (isOverride(r))
        push(r.transactionDate, {
          kind: "balance-update",
          label: r.description,
          amount: parseFloat(String(r.amount)),
        });
      continue;
    }
    if (isCcChild(r) || r.status === "missed" || r.status === "removed") continue;
    if (isOverride(r)) {
      push(r.transactionDate, {
        kind: "balance-update",
        label: r.description,
        amount: parseFloat(String(r.amount)),
      });
      continue;
    }
    const kind: Ev["kind"] =
      r.transactionType === "income"
        ? "income"
        : r.isCcParent
          ? "card-payment"
          : r.sourceBillId != null
            ? "bill"
            : "other";
    push(r.transactionDate, {
      kind,
      label: r.description,
      amount: cents(signedF(r)),
      cycleId: r.sourceCardCycleId ?? null,
      category: r.category,
    });
  }

  // ACTUALS — past days, from posted Plaid transactions on cash accounts.
  if (monthStart < todayStr) {
    const pastEnd = monthEnd < todayStr ? monthEnd : addDaysIso(todayStr, -1);
    const txns = await db
      .select({
        id: plaidTransactionsTable.id,
        date: plaidTransactionsTable.date,
        amount: plaidTransactionsTable.amount,
        name: plaidTransactionsTable.name,
        merchantName: plaidTransactionsTable.merchantName,
        primary: plaidTransactionsTable.personalFinanceCategory,
        detailed: plaidTransactionsTable.personalFinanceCategoryDetailed,
        accountType: accountsTable.accountType,
      })
      .from(plaidTransactionsTable)
      .leftJoin(accountsTable, eq(accountsTable.plaidAccountId, plaidTransactionsTable.accountId))
      .where(
        and(
          eq(plaidTransactionsTable.userId, req.userId),
          eq(plaidTransactionsTable.pending, false),
          gte(plaidTransactionsTable.date, monthStart),
          lte(plaidTransactionsTable.date, pastEnd),
        ),
      );
    const userBills = await db
      .select({ billName: billsTable.billName, matchMerchant: billsTable.matchMerchant })
      .from(billsTable)
      .where(and(eq(billsTable.userId, req.userId), eq(billsTable.isActive, true), isNotNull(billsTable.matchMerchant)));
    const billOf = (label: string): string | null => {
      const lower = label.toLowerCase();
      for (const b of userBills) if (b.matchMerchant && lower.includes(b.matchMerchant.toLowerCase())) return b.billName;
      return null;
    };
    // P6: transactions confirmed as a bill's payment are that bill — never
    // bucketed as separate spend (the reconciled forecast row and the posted
    // transaction are ONE cash event).
    const reconciled = await db
      .select({
        matchedId: forecastedTransactionsTable.matchedPlaidTransactionId,
        description: forecastedTransactionsTable.description,
      })
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.userId, req.userId),
        isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      ));
    const billNameByTxnId = new Map(reconciled.map((r) => [r.matchedId!, r.description]));
    const titleCase = (s: string) =>
      s
        .toLowerCase()
        .split("_")
        .map((w) => (w === "and" ? "&" : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(" ");

    // Bucket cash-account spend by day + category; other kinds are lines.
    const buckets = new Map<string, { date: string; category: string; charges: Array<{ date: string; name: string; amount: number }> }>();
    for (const t of txns) {
      if (t.accountType === "credit_card") continue; // card charges live inside cycles, not the cash view
      const amt = parseFloat(String(t.amount)); // Plaid: positive = outflow
      const label = t.merchantName ?? t.name ?? "Transaction";
      if (amt < 0) {
        push(t.date, { kind: "income", label, amount: cents(-amt) });
        continue;
      }
      const isCardPayment =
        (t.detailed ?? "").includes("CREDIT_CARD_PAYMENT") || (t.primary === "LOAN_PAYMENTS" && (t.detailed ?? "").includes("CREDIT_CARD"));
      if (isCardPayment) {
        push(t.date, { kind: "card-payment", label, amount: cents(-amt) });
        continue;
      }
      const billName = billNameByTxnId.get(t.id) ?? billOf(label);
      if (billName) {
        push(t.date, { kind: "bill", label: billName, amount: cents(-amt) });
        continue;
      }
      const category = titleCase(t.primary ?? "OTHER");
      const key = `${t.date}|${category}`;
      const bucket = buckets.get(key) ?? { date: t.date, category, charges: [] };
      bucket.charges.push({ date: t.date, name: label, amount: cents(-amt) });
      buckets.set(key, bucket);
    }
    for (const b of buckets.values()) {
      const total = cents(b.charges.reduce((s, c) => s + c.amount, 0));
      push(b.date, {
        kind: "spend",
        label: b.category,
        amount: total,
        category: b.category,
        count: b.charges.length,
        charges: b.charges.sort((x, y) => y.amount - x.amount || x.name.localeCompare(y.name)),
      });
    }
  }

  // Roll the balance across the month: re-anchor at balance updates, then
  // apply the day's net. On override days the ledger treats the entered
  // balance as the value at the override row (first row of its date) with the
  // day's FORECAST rows applying after it — so step those days with the
  // forecast net, not the displayed plaid net, to stay ledger-consistent and
  // avoid double-applying actuals the entered balance already reflects.
  const forecastNetByDate = new Map<string, number>();
  for (const r of flows) {
    if (r.transactionDate < monthStart || r.transactionDate > monthEnd) continue;
    forecastNetByDate.set(r.transactionDate, (forecastNetByDate.get(r.transactionDate) ?? 0) + signedF(r));
  }
  const days: Array<{ date: string; net: number; endBalance: number; events: Ev[] }> = [];
  let bal = startBalance;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const events = (eventsByDate.get(date) ?? []).sort((a, b) => {
      const order = { "balance-update": 0, income: 1, bill: 2, "card-payment": 3, other: 4, spend: 5 } as const;
      return order[a.kind] - order[b.kind] || b.amount - a.amount;
    });
    const anchor = events.find((e) => e.kind === "balance-update");
    const net = cents(events.filter((e) => e.kind !== "balance-update").reduce((s, e) => s + e.amount, 0));
    if (anchor) {
      bal = cents(anchor.amount + (forecastNetByDate.get(date) ?? 0));
    } else {
      bal = cents(bal + net);
    }
    days.push({ date, net, endBalance: bal, events });
  }

  res.json(GetForecastCalendarResponse.parse({ month, today: todayStr, days }));
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
  // P6 part 2: with an anchored forecast start date, planned rows are also
  // generated for the PAST window [startDate, today) so the actuals roll can
  // reconcile them against posted transactions or mark them missed. The
  // delete/regenerate boundary extends back to the start date; paid/committed
  // rows still survive, and missed rows are simply re-derived.
  const [regenSettings] = await db
    .select({ forecastStartDate: userSettingsTable.forecastStartDate })
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId));
  const genStartStr =
    regenSettings?.forecastStartDate && regenSettings.forecastStartDate < regenTodayStr
      ? regenSettings.forecastStartDate
      : regenTodayStr;
  await db.delete(forecastedTransactionsTable).where(
    and(
      eq(forecastedTransactionsTable.isActual, false),
      eq(forecastedTransactionsTable.isCommitted, false),
      isNull(forecastedTransactionsTable.sourceBalanceSyncId),
      gte(forecastedTransactionsTable.transactionDate, genStartStr),
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
  const ccById = new Map<number, typeof ccAccounts[number]>();
  for (const acct of ccAccounts) {
    if (acct.ccCycleStartDate != null && acct.ccCycleEndDate != null && acct.ccPaymentDueDate != null) {
      ccById.set(acct.id, acct);
    }
  }

  // P5 cycle-backed cards: accounts with generated card_cycles get ONE
  // forecast outflow per cycle on its due_date (Stage 4). Their card-paid
  // bills and charges are NEVER standalone forecast lines — they live inside
  // the cycle payment. Assumes the statement is paid in full each cycle
  // (partial-payment / revolving balances are out of scope).
  const allCycles = ccAccounts.length
    ? await db.select().from(cardCyclesTable).where(inArray(cardCyclesTable.accountId, ccAccounts.map((a) => a.id)))
    : [];
  const cycleBackedAccountIds = new Set(allCycles.map((c) => c.accountId));

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
      gte(forecastedTransactionsTable.transactionDate, genStartStr),
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
      // A reconciled row was MOVED to the actual posted date; its planned
      // occurrence (forecastedDate) is covered by it too — don't re-emit it.
      if (row.sourceBillId != null && row.forecastedDate != null) {
        preservedKeys.add(`bill|${row.sourceBillId}|${row.forecastedDate}`);
      }
    }
  }
  // Reconciled rows moved to a PAST date (paid early) fall outside the
  // preservedRows window above, but their planned occurrence may still be in
  // the future — regeneration must not re-emit it as a duplicate planned bill.
  const pastReconciled = await db
    .select({
      sourceBillId: forecastedTransactionsTable.sourceBillId,
      forecastedDate: forecastedTransactionsTable.forecastedDate,
    })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      lt(forecastedTransactionsTable.transactionDate, regenTodayStr),
      gte(forecastedTransactionsTable.forecastedDate, regenTodayStr),
    ));
  for (const row of pastReconciled) {
    if (row.sourceBillId != null && row.forecastedDate != null) {
      preservedKeys.add(`bill|${row.sourceBillId}|${row.forecastedDate}`);
    }
  }

  for (const bill of bills) {
    const amount = parseFloat(String(bill.amount));
    // Bills paid by a cycle-backed card are represented inside the cycle's
    // due-date payment (emitted below) — no standalone or grouped lines.
    if (bill.paymentAccountId != null && cycleBackedAccountIds.has(bill.paymentAccountId)) {
      continue;
    }
    // Bills paid by a configured credit card (structured link via
    // paymentAccountId) group into that card's payment cycle.
    const card =
      bill.paymentMethod === "credit-card" && bill.paymentAccountId != null
        ? ccById.get(bill.paymentAccountId)
        : undefined;

    for (const dateStr of generateBillOccurrences(bill, genStartStr, endStr)) {
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
    // Never recreate legacy parents for cycle-backed cards.
    if (cycleBackedAccountIds.has(Number(acctIdStr))) continue;
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

  // P5 Stage 4: one cash outflow per card cycle, on its due_date.
  //   Closed cycle (past cycle_end): amount = accumulated_total (the actual
  //   statement) — basis 'actual'.
  //   Open cycle: amount = max(accumulated so far, planned_total) — basis
  //   'projected' (early in a cycle plan is the better estimate; late, actual
  //   may exceed plan; max never understates the payment).
  const acctNameById = new Map(ccAccounts.map((a) => [a.id, a.accountName]));
  // Dedupe against surviving cycle rows (isActual/isCommitted rows are
  // preserved by the delete above — never insert a second payment row for
  // the same cycle).
  const survivingCycleRows = await db
    .select({ sourceCardCycleId: forecastedTransactionsTable.sourceCardCycleId })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      isNotNull(forecastedTransactionsTable.sourceCardCycleId),
    ));
  const survivingCycleIds = new Set(survivingCycleRows.map((r) => r.sourceCardCycleId));
  for (const cyc of allCycles) {
    if (cyc.dueDate < todayStr || cyc.dueDate > endStr) continue;
    if (survivingCycleIds.has(cyc.id)) continue;
    const accumulated = parseFloat(String(cyc.accumulatedTotal ?? "0")) || 0;
    const planned = parseFloat(String(cyc.plannedTotal ?? "0")) || 0;
    const closed = todayStr > cyc.cycleEnd;
    const amount = closed ? accumulated : Math.max(accumulated, planned);
    toInsert.push({
      userId,
      transactionDate: cyc.dueDate,
      description: `${acctNameById.get(cyc.accountId) ?? "Credit card"} payment`,
      amount: String(Math.round(amount * 100) / 100),
      transactionType: "expense",
      category: "debt_payments",
      ccAccountId: cyc.accountId,
      isCcParent: true,
      sourceCardCycleId: cyc.id,
      ccBasis: closed ? "actual" : "projected",
      isActual: false,
      isCommitted: false,
      sortOrder: 0,
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
      if (toLocalIso(current) >= genStartStr && !preservedKeys.has(`pay|${ps.id}|${current.toISOString().split("T")[0]}`)) {
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

  // P6 part 2: refresh the forecast past (resolve stale planned rows and
  // rebuild the unplanned actual buckets) whenever the plan is rebuilt.
  await rollActualsForUser(userId);

  return toInsert.length;
}

// ── P6 part 2: forecast start date + anchor balance ─────────────────────────
// Reconstructs each bank account's balance as of the chosen start date:
//   balance(start) = current_balance + Σ posted outflows − Σ posted inflows
// over [start, today]  (Plaid amounts are positive for outflows, so this is
// simply current + Σ amount). Saves the anchor into user_settings and rebuilds
// the forecast unless preview=true.
router.post("/forecast/anchor", async (req, res): Promise<void> => {
  const parsed = AnchorForecastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { startDate, preview } = parsed.data;
  const todayStr = toLocalIso(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || startDate > todayStr) {
    res.status(400).json({ error: "startDate must be a past or current date (YYYY-MM-DD)" });
    return;
  }

  const bankAccounts = await db
    .select()
    .from(accountsTable)
    .where(and(
      eq(accountsTable.userId, req.userId),
      isNotNull(accountsTable.plaidAccountId),
    ));
  const cashAccounts = bankAccounts.filter((a) => a.accountType !== "credit_card");

  const breakdown: Array<{ accountId: number; accountName: string; currentBalance: number; netSinceStart: number; startBalance: number }> = [];
  for (const acct of cashAccounts) {
    const txns = await db
      .select({ amount: plaidTransactionsTable.amount })
      .from(plaidTransactionsTable)
      .where(and(
        eq(plaidTransactionsTable.userId, req.userId),
        eq(plaidTransactionsTable.accountId, acct.plaidAccountId!),
        eq(plaidTransactionsTable.pending, false),
        gte(plaidTransactionsTable.date, startDate),
        lte(plaidTransactionsTable.date, todayStr), // never let future-dated records bias the anchor
      ));
    const netOut = txns.reduce((s, t) => s + parseFloat(String(t.amount)), 0);
    const current = parseFloat(String(acct.currentBalance ?? 0));
    const startBal = Math.round((current + netOut) * 100) / 100;
    breakdown.push({
      accountId: acct.id,
      accountName: acct.accountName,
      currentBalance: Math.round(current * 100) / 100,
      netSinceStart: Math.round(-netOut * 100) / 100, // net cash flow (inflow positive) since start
      startBalance: startBal,
    });
  }
  const anchorBalance = Math.round(breakdown.reduce((s, a) => s + a.startBalance, 0) * 100) / 100;

  if (!preview) {
    await db
      .insert(userSettingsTable)
      .values({ userId: req.userId, startingBalance: String(anchorBalance), balanceAsOfDate: startDate, forecastStartDate: startDate })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { startingBalance: String(anchorBalance), balanceAsOfDate: startDate, forecastStartDate: startDate, updatedAt: new Date() },
      });
    await regenerateForecastForUser(req.userId); // also rolls actuals
  }

  res.json({ startDate, anchorBalance, accounts: breakdown, saved: !preview });
});

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
  const forecastStartDate = settings?.forecastStartDate ?? null;

  // With an anchored start date, flows from the start date forward define the
  // balance; without one, keep the legacy 30-day lookback.
  const rowsFrom = forecastStartDate && forecastStartDate < windowStart ? forecastStartDate : windowStart;
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
      gte(forecastedTransactionsTable.transactionDate, rowsFrom),
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
  const flows = rows.filter((r) => r.sourceBalanceSyncId == null && r.status !== "missed" && r.status !== "removed");

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
  } else if (forecastStartDate && syncDate >= forecastStartDate) {
    // Anchored mode: startingBalance is the balance AS OF forecastStartDate;
    // roll forward through the flows between the start date and syncDate.
    bal = startingBalance + flows
      .filter((r) => r.transactionDate >= forecastStartDate && r.transactionDate < syncDate)
      .reduce((s, r) => s + signed(r), 0);
  } else {
    // Legacy mode: startingBalance is the balance at the start of today.
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

// ── P6: planned-vs-actual reconciliation for bank-paid bills ────────────────

router.get("/forecast/reconcile-candidates", async (req, res): Promise<void> => {
  const suggestions = await findReconcileSuggestions(req.userId);
  res.json(suggestions);
});

/** Load a user's forecast row + validate it's a bank-paid bill row. */
async function ownedRow(id: number, userId: string) {
  const [row] = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(eq(forecastedTransactionsTable.id, id), eq(forecastedTransactionsTable.userId, userId)));
  return row;
}

router.post("/forecast/:id/reconcile", async (req, res): Promise<void> => {
  const params = UpdateForecastedTransactionParams.safeParse(req.params);
  const body = ReconcileForecastedTransactionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error!.message });
    return;
  }
  const row = await ownedRow(params.data.id, req.userId);
  if (!row) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  if ((row.sourceBillId == null && row.sourcePayId == null) || row.sourceCardCycleId != null || row.ccAccountId != null) {
    res.status(400).json({ error: "Only standalone bank-paid bill or paycheck rows can be reconciled" });
    return;
  }
  if (row.isActual || row.matchedPlaidTransactionId != null) {
    res.status(400).json({ error: "This row is already confirmed" });
    return;
  }
  // Re-derive candidates server-side so a stale client can't link an
  // arbitrary transaction: the pair must still be a valid match. Any listed
  // candidate is acceptable — when several qualify, the user's choice wins.
  const suggestions = await findReconcileSuggestions(req.userId);
  const match = suggestions
    .find((s) => s.forecastTransactionId === row.id)
    ?.candidates.find((c) => c.plaidTransactionId === body.data.plaidTransactionId);
  if (!match) {
    res.status(400).json({ error: "That transaction is no longer a valid match for this row" });
    return;
  }
  const [updated] = await db
    .update(forecastedTransactionsTable)
    .set({
      transactionDate: match.actualDate,
      amount: String(match.actualAmount),
      // Snapshot the immediate pre-confirm values so un-confirm reverts to
      // them (always overwrite: a stale forecastedAmount from an older manual
      // edit would otherwise revert the row to the wrong baseline).
      forecastedDate: row.transactionDate,
      forecastedAmount: row.amount,
      isActual: true,
      isCommitted: true,
      status: null,
      matchedPlaidTransactionId: match.plaidTransactionId,
    })
    .where(eq(forecastedTransactionsTable.id, row.id))
    .returning();
  await rollActualsForUser(req.userId); // the linked txn leaves the unplanned buckets
  res.json(serialize(updated));
});

router.post("/forecast/:id/unreconcile", async (req, res): Promise<void> => {
  const params = UpdateForecastedTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await ownedRow(params.data.id, req.userId);
  if (!row) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  if (row.matchedPlaidTransactionId == null) {
    res.status(400).json({ error: "This row is not reconciled to a transaction" });
    return;
  }
  const [updated] = await db
    .update(forecastedTransactionsTable)
    .set({
      transactionDate: row.forecastedDate ?? row.transactionDate,
      ...(row.forecastedAmount != null && { amount: String(row.forecastedAmount), forecastedAmount: null }),
      forecastedDate: null,
      isActual: false,
      isCommitted: false,
      status: null,
      matchedPlaidTransactionId: null,
    })
    .where(eq(forecastedTransactionsTable.id, row.id))
    .returning();
  await rollActualsForUser(req.userId); // the unlinked txn may re-enter the buckets
  res.json(serialize(updated));
});

router.post("/forecast/:id/dismiss-match", async (req, res): Promise<void> => {
  const params = UpdateForecastedTransactionParams.safeParse(req.params);
  const body = ReconcileForecastedTransactionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error!.message });
    return;
  }
  const row = await ownedRow(params.data.id, req.userId);
  if (!row || (row.sourceBillId == null && row.sourcePayId == null)) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  // The dismissed transaction must belong to this user (prevents arbitrary
  // pair inserts against other users' transaction ids).
  const [txn] = await db
    .select({ id: plaidTransactionsTable.id })
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.id, body.data.plaidTransactionId),
      eq(plaidTransactionsTable.userId, req.userId),
    ));
  if (!txn) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  await db
    .insert(billMatchDismissalsTable)
    .values({
      userId: req.userId,
      billId: row.sourceBillId,
      payScheduleId: row.sourceBillId == null ? row.sourcePayId : null,
      plaidTransactionId: body.data.plaidTransactionId,
    })
    .onConflictDoNothing();
  await rollActualsForUser(req.userId); // a dismissed txn becomes unplanned spend
  res.sendStatus(204);
});

// "Didn't happen" — the user asserts a past planned row never occurred.
// The row is removed from the ledger (list responses filter it out) and stops
// stepping the running balance. It is kept in the DB as committed so forecast
// regeneration doesn't re-emit the same occurrence.
router.post("/forecast/:id/didnt-happen", async (req, res): Promise<void> => {
  const params = UpdateForecastedTransactionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await ownedRow(params.data.id, req.userId);
  if (!row) {
    res.status(404).json({ error: "Forecasted transaction not found" });
    return;
  }
  if (row.isActual || row.matchedPlaidTransactionId != null) {
    res.status(400).json({ error: "This row is confirmed against real activity — un-confirm it first" });
    return;
  }
  if (row.sourceBalanceSyncId != null || row.sourceCardCycleId != null || row.isUnplanned) {
    res.status(400).json({ error: "Only planned rows can be removed as didn't-happen" });
    return;
  }
  // Only PAST rows can be resolved as didn't-happen — future rows are
  // projections; removing one would permanently suppress the occurrence.
  if (row.transactionDate > toLocalIso(new Date())) {
    res.status(400).json({ error: "Future planned rows can't be resolved yet — edit or delete the plan instead" });
    return;
  }
  await db
    .update(forecastedTransactionsTable)
    .set({ status: "removed", isActual: false, isCommitted: true })
    .where(eq(forecastedTransactionsTable.id, row.id));
  await rollActualsForUser(req.userId);
  res.sendStatus(204);
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

  // Cycle payment rows are derived from the card-cycle engine; editing or
  // marking them paid would desync from the rollup and (since isActual /
  // isCommitted rows survive regeneration) risk duplicate payment rows.
  if (existing.sourceCardCycleId != null) {
    res.status(400).json({ error: "Card cycle payments are managed automatically from the card's cycle — they can't be edited or marked paid here" });
    return;
  }

  // Unplanned actual rows are derived from posted bank activity and rebuilt
  // on every sync — edits would be silently overwritten.
  if (existing.isUnplanned) {
    res.status(400).json({ error: "Unplanned spending rows reflect posted bank activity and can't be edited" });
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
      isUnplanned: forecastedTransactionsTable.isUnplanned,
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
  if (existing.isUnplanned) {
    res.status(400).json({ error: "Unplanned spending rows reflect posted bank activity and can't be deleted — they are rebuilt on every sync" });
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
      // Cycle-based payment rows get their amount from the cycle rollup,
      // never from child sums (they have no children).
      isNull(forecastedTransactionsTable.sourceCardCycleId),
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
