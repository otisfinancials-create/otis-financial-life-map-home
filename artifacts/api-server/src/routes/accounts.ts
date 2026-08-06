import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, accountsTable, savingsSnapshotsTable, accountGoalsTable, plaidItemsTable, balanceSnapshotsTable } from "@workspace/db";
import {
  CreateAccountBody,
  UpdateAccountBody,
  GetAccountParams,
  UpdateAccountParams,
  DeleteAccountParams,
  ListAccountsResponse,
  CreateAccountResponse,
  GetAccountResponse,
  UpdateAccountResponse,
  GetAccountsSummaryResponse,
  GetSavingsSummaryResponse,
  ListAccountGoalsResponse,
  SetAccountGoalParams,
  SetAccountGoalBody,
  SetAccountGoalResponse,
  ListAccountBalancesResponse,
  UpdateAccountCycleConfigParams,
  UpdateAccountCycleConfigBody,
  UpdateAccountCycleConfigResponse,
  ListAccountCyclesParams,
  ListAccountCyclesResponse,
  GenerateAccountCyclesParams,
  GenerateAccountCyclesResponse,
  UpdateAccountPaymentModeParams,
  UpdateAccountPaymentModeBody,
  UpdateAccountPaymentModeResponse,
  DismissPaymentSuggestionParams,
  DismissPaymentSuggestionResponse,
} from "@workspace/api-zod";
import { cardCyclesTable, billsTable, type CardCycle } from "@workspace/db";
import { generateCyclesForAccount, deleteCycleWithDependentsTx } from "../services/card-cycles";
import { regenerateForecastForUser, buildFixedPaymentSchedule } from "./forecast";

const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "brokerage"];

const router: IRouter = Router();

router.get("/accounts", async (req, res): Promise<void> => {
  req.log.info("Fetching accounts");
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId))
    .orderBy(accountsTable.accountType, accountsTable.accountName);
  const items = await db
    .select({
      id: plaidItemsTable.id,
      institutionLogo: plaidItemsTable.institutionLogo,
      lastSyncedAt: plaidItemsTable.lastSyncedAt,
      lastSyncAttemptedAt: plaidItemsTable.lastSyncAttemptedAt,
      lastSyncError: plaidItemsTable.lastSyncError,
      lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      consecutiveFailures: plaidItemsTable.consecutiveFailures,
      needsReauth: plaidItemsTable.needsReauth,
    })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, req.userId));
  const itemById = new Map(items.map((i) => [i.id, i]));
  res.json(
    ListAccountsResponse.parse(
      accounts.map((a) => {
        const item = a.plaidItemId != null ? itemById.get(a.plaidItemId) : undefined;
        return {
          ...serialize(a),
          institutionLogo: item?.institutionLogo ?? null,
          // The item-level timestamp is the source of truth for when this
          // connection last synced; the per-account column can go stale.
          lastSyncedAt: item?.lastSyncedAt
            ? item.lastSyncedAt.toISOString()
            : a.lastSyncedAt
              ? a.lastSyncedAt.toISOString()
              : null,
          // Connection health: an item is FAILING only when an actual attempt
          // failed (lastSyncError set). An old lastSyncedAt with no failed
          // attempt is idle-but-healthy, never a failure state.
          lastSyncAttemptedAt: item?.lastSyncAttemptedAt ? item.lastSyncAttemptedAt.toISOString() : null,
          lastSyncError: item?.lastSyncError ?? null,
          lastSyncErrorCode: item?.lastSyncErrorCode ?? null,
          consecutiveFailures: item?.consecutiveFailures ?? 0,
          needsReauth: item?.needsReauth ?? false,
        };
      }),
    ),
  );
});

// P4: latest daily balance snapshot per connected account (must precede /accounts/:id).
router.get("/accounts/balances", async (req, res): Promise<void> => {
  req.log.info("Fetching latest account balance snapshots");
  const rows = await db
    .select({
      accountId: balanceSnapshotsTable.accountId,
      snapshotDate: balanceSnapshotsTable.snapshotDate,
      current: balanceSnapshotsTable.current,
      available: balanceSnapshotsTable.available,
      creditLimit: balanceSnapshotsTable.creditLimit,
      currencyCode: balanceSnapshotsTable.currencyCode,
      capturedAt: balanceSnapshotsTable.capturedAt,
      accountName: accountsTable.accountName,
    })
    .from(balanceSnapshotsTable)
    .leftJoin(
      accountsTable,
      and(eq(accountsTable.plaidAccountId, balanceSnapshotsTable.accountId), eq(accountsTable.userId, req.userId)),
    )
    .where(
      and(
        eq(balanceSnapshotsTable.userId, req.userId),
        sql`(${balanceSnapshotsTable.accountId}, ${balanceSnapshotsTable.snapshotDate}) IN (
          SELECT account_id, MAX(snapshot_date) FROM balance_snapshots
          WHERE user_id = ${req.userId} GROUP BY account_id
        )`,
      ),
    )
    .orderBy(sql`COALESCE(${accountsTable.accountName}, ${balanceSnapshotsTable.accountId})`);
  res.json(
    ListAccountBalancesResponse.parse(
      rows.map((r) => ({
        accountId: r.accountId,
        accountName: r.accountName ?? null,
        snapshotDate: r.snapshotDate,
        current: r.current != null ? parseFloat(String(r.current)) : null,
        available: r.available != null ? parseFloat(String(r.available)) : null,
        creditLimit: r.creditLimit != null ? parseFloat(String(r.creditLimit)) : null,
        currencyCode: r.currencyCode ?? null,
        capturedAt: r.capturedAt.toISOString(),
      })),
    ),
  );
});

router.post("/accounts", async (req, res): Promise<void> => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [account] = await db.insert(accountsTable).values({
    ...parsed.data,
    userId: req.userId,
    currentBalance: String(parsed.data.currentBalance),
    monthlyContribution: String(parsed.data.monthlyContribution ?? 0),
    savingsGoal: parsed.data.savingsGoal != null ? String(parsed.data.savingsGoal) : null,
  }).returning();
  res.status(201).json(CreateAccountResponse.parse(serialize(account)));
});

router.get("/account-goals", async (req, res): Promise<void> => {
  req.log.info("Fetching account goals");
  const goals = await db
    .select()
    .from(accountGoalsTable)
    .where(eq(accountGoalsTable.userId, req.userId));
  res.json(
    ListAccountGoalsResponse.parse(
      goals.map((g) => ({ accountId: g.accountId, goalAmount: parseFloat(String(g.goalAmount)) })),
    ),
  );
});

router.put("/account-goals/:accountId", async (req, res): Promise<void> => {
  const params = SetAccountGoalParams.safeParse(req.params);
  const body = SetAccountGoalBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const { accountId } = params.data;
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.id, accountId), eq(accountsTable.userId, req.userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const { goalAmount } = body.data;
  if (goalAmount == null) {
    await db
      .delete(accountGoalsTable)
      .where(and(eq(accountGoalsTable.userId, req.userId), eq(accountGoalsTable.accountId, accountId)));
    res.json(SetAccountGoalResponse.parse({ accountId, goalAmount: null }));
    return;
  }
  await db
    .insert(accountGoalsTable)
    .values({ userId: req.userId, accountId, goalAmount: String(goalAmount) })
    .onConflictDoUpdate({
      target: [accountGoalsTable.userId, accountGoalsTable.accountId],
      set: { goalAmount: String(goalAmount), updatedAt: new Date() },
    });
  res.json(SetAccountGoalResponse.parse({ accountId, goalAmount }));
});

router.get("/savings/summary", async (req, res): Promise<void> => {
  req.log.info("Fetching savings summary");
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId));
  const savingsAccounts = accounts.filter((a) => SAVINGS_INVESTMENT_TYPES.includes(a.accountType));
  const total = savingsAccounts.reduce((s, a) => s + parseFloat(String(a.currentBalance)), 0);

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prior = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const priorMonth = `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, "0")}`;

  // Upsert this month's snapshot so future months have a comparison point.
  await db
    .insert(savingsSnapshotsTable)
    .values({ userId: req.userId, month, total: String(Math.round(total * 100) / 100) })
    .onConflictDoUpdate({
      target: [savingsSnapshotsTable.userId, savingsSnapshotsTable.month],
      set: { total: String(Math.round(total * 100) / 100), updatedAt: new Date() },
    });

  const [priorSnap] = await db
    .select()
    .from(savingsSnapshotsTable)
    .where(and(eq(savingsSnapshotsTable.userId, req.userId), eq(savingsSnapshotsTable.month, priorMonth)));

  const priorMonthTotal = priorSnap ? parseFloat(String(priorSnap.total)) : null;
  res.json(
    GetSavingsSummaryResponse.parse({
      total,
      accountCount: savingsAccounts.length,
      priorMonthTotal,
      momChange: priorMonthTotal != null ? total - priorMonthTotal : null,
    }),
  );
});

router.get("/accounts/summary", async (req, res): Promise<void> => {
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId));

  // Totals are scoped to accounts only (this page); the global net worth
  // that also includes manual assets & liabilities lives on the dashboard.
  const totalAssets = accounts
    .filter((a) => a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const totalLiabilities = accounts
    .filter((a) => !a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  const byTypeMap: Record<string, { total: number; count: number }> = {};
  for (const account of accounts) {
    const type = account.accountType;
    if (!byTypeMap[type]) byTypeMap[type] = { total: 0, count: 0 };
    const balance = parseFloat(String(account.currentBalance));
    byTypeMap[type].total += account.isAsset ? balance : -balance;
    byTypeMap[type].count += 1;
  }

  const byType = Object.entries(byTypeMap).map(([accountType, { total, count }]) => ({
    accountType,
    total,
    count,
  }));

  res.json(GetAccountsSummaryResponse.parse({ netWorth, totalAssets, totalLiabilities, byType }));
});

router.get("/accounts/:id", async (req, res): Promise<void> => {
  const params = GetAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.id, params.data.id), eq(accountsTable.userId, req.userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(GetAccountResponse.parse(serialize(account)));
});

router.patch("/accounts/:id", async (req, res): Promise<void> => {
  const params = UpdateAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { currentBalance: rawBalance, monthlyContribution: rawContribution, savingsGoal: rawGoal, ...restAccountData } = parsed.data;
  // Credit cards can NEVER be forecast accounts, regardless of input.
  const [existingAccount] = await db
    .select({ accountType: accountsTable.accountType })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, params.data.id), eq(accountsTable.userId, req.userId)));
  const targetType = restAccountData.accountType ?? existingAccount?.accountType;
  if (targetType === "credit_card") restAccountData.isForecastAccount = false;
  const [account] = await db
    .update(accountsTable)
    .set({
      ...restAccountData,
      ...(rawBalance !== undefined && { currentBalance: String(rawBalance) }),
      ...(rawContribution !== undefined && { monthlyContribution: String(rawContribution) }),
      ...(rawGoal !== undefined && { savingsGoal: rawGoal != null ? String(rawGoal) : null }),
      updatedAt: new Date(),
    })
    .where(and(eq(accountsTable.id, params.data.id), eq(accountsTable.userId, req.userId)))
    .returning();
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.json(UpdateAccountResponse.parse(serialize(account)));
});

router.delete("/accounts/:id", async (req, res): Promise<void> => {
  const params = DeleteAccountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  // Clear rows referencing this account, or the delete hits FK errors:
  // card cycles (with envelopes/allocations/forecast rows), bills that pay
  // from it (detach, keep the bill), and account goals. One transaction so a
  // failure can't leave the account half-detached.
  await db.transaction(async (tx) => {
    const cycles = await tx
      .select({ id: cardCyclesTable.id })
      .from(cardCyclesTable)
      .where(eq(cardCyclesTable.accountId, account.id));
    for (const c of cycles) await deleteCycleWithDependentsTx(tx, c.id);
    await tx
      .update(billsTable)
      .set({ paymentAccountId: null })
      .where(eq(billsTable.paymentAccountId, account.id));
    await tx.delete(accountGoalsTable).where(eq(accountGoalsTable.accountId, account.id));
    await tx.delete(accountsTable).where(eq(accountsTable.id, account.id));
  });
  // Detached bills / removed cycles change the forecast — always rebuild.
  await regenerateForecastForUser(req.userId);
  res.sendStatus(204);
});

// ── P5 Stage 1: card cycle config + generation ─────────────────────────────

function serializeCycle(c: CardCycle) {
  return {
    id: c.id,
    accountId: c.accountId,
    cycleStart: c.cycleStart,
    cycleEnd: c.cycleEnd,
    dueDate: c.dueDate,
    plannedTotal: c.plannedTotal != null ? parseFloat(String(c.plannedTotal)) : 0,
    accumulatedTotal: c.accumulatedTotal != null ? parseFloat(String(c.accumulatedTotal)) : 0,
    status: c.status ?? "open",
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function ownedAccount(id: number, userId: string) {
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.id, id), eq(accountsTable.userId, userId)));
  return account;
}

router.patch("/accounts/:id/cycle-config", async (req, res): Promise<void> => {
  const params = UpdateAccountCycleConfigParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAccountCycleConfigBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  await db
    .update(accountsTable)
    .set({ statementDay: body.data.statementDay, dueDay: body.data.dueDay, updatedAt: new Date() })
    .where(eq(accountsTable.id, account.id));
  const cycles = await generateCyclesForAccount(account.id);
  // Cycle windows may have been replaced/removed — rebuild their payment rows.
  await regenerateForecastForUser(req.userId);
  res.json(UpdateAccountCycleConfigResponse.parse(cycles.map(serializeCycle)));
});

router.patch("/accounts/:id/payment-mode", async (req, res): Promise<void> => {
  const params = UpdateAccountPaymentModeParams.safeParse(req.params);
  const body = UpdateAccountPaymentModeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.success ? body : params).error!.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  if (account.accountType !== "credit_card") {
    res.status(400).json({ error: "Payment mode applies to credit cards only" });
    return;
  }
  const mode = body.data.paymentMode;
  const fixedAmt = body.data.fixedPaymentAmount ?? null;
  if (mode === "fixed" && (fixedAmt == null || fixedAmt <= 0)) {
    res.status(400).json({ error: "fixedPaymentAmount is required for fixed mode" });
    return;
  }
  const target = mode === "fixed" ? (body.data.payoffTargetDate ?? null) : null;
  if (target != null && (!/^\d{4}-\d{2}-\d{2}$/.test(target) || Number.isNaN(Date.parse(target)))) {
    res.status(400).json({ error: "payoffTargetDate must be a valid YYYY-MM-DD date" });
    return;
  }
  await db
    .update(accountsTable)
    .set({
      paymentMode: mode,
      fixedPaymentAmount: mode === "fixed" ? String(fixedAmt) : null,
      payoffTargetDate: target,
      // Accepting or configuring a mode settles the suggestion.
      paymentSuggestionDismissedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(accountsTable.id, account.id));
  await regenerateForecastForUser(req.userId);

  // Payoff projection from the SAME schedule builder the forecast uses —
  // seam date + real cycle due dates + monthly extension — so the reported
  // payoff can never disagree with the emitted rows. Horizon unbounded here:
  // the payoff date is real even if it lies past the forecast window.
  let projectedPayoffDate: string | null = null;
  let shortfallAtTarget: number | null = null;
  const balance = account.lastStatementBalance != null ? parseFloat(String(account.lastStatementBalance)) : 0;
  if (mode === "fixed" && fixedAmt != null && balance > 0) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const cycles = await db
      .select({ dueDate: cardCyclesTable.dueDate, id: cardCyclesTable.id })
      .from(cardCyclesTable)
      .where(and(eq(cardCyclesTable.accountId, account.id), eq(cardCyclesTable.userId, req.userId)));
    const { slots } = buildFixedPaymentSchedule({
      fixedAmt,
      balance,
      stmtDue: account.nextPaymentDueDate,
      cycleDues: cycles.filter((c) => c.dueDate >= todayStr).map((c) => ({ date: c.dueDate, cycleId: c.id })),
      todayStr,
      endStr: "9999-12-31",
    });
    projectedPayoffDate = slots.length ? slots[slots.length - 1].date : null;
    if (target) {
      const paidByTarget = slots.filter((s) => s.date <= target).reduce((s, x) => s + x.portion, 0);
      const remaining = Math.max(0, Math.round((balance - paidByTarget) * 100) / 100);
      shortfallAtTarget = remaining > 0 ? remaining : null;
    }
  }
  const [updated] = await db.select().from(accountsTable).where(eq(accountsTable.id, account.id));
  res.json(UpdateAccountPaymentModeResponse.parse({
    account: serialize(updated),
    projectedPayoffDate,
    shortfallAtTarget,
  }));
});

router.post("/accounts/:id/dismiss-payment-suggestion", async (req, res): Promise<void> => {
  const params = DismissPaymentSuggestionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  await db
    .update(accountsTable)
    .set({ paymentSuggestionDismissedAt: new Date(), updatedAt: new Date() })
    .where(eq(accountsTable.id, account.id));
  const [updated] = await db.select().from(accountsTable).where(eq(accountsTable.id, account.id));
  res.json(DismissPaymentSuggestionResponse.parse(serialize(updated)));
});

router.get("/accounts/:id/cycles", async (req, res): Promise<void> => {
  const params = ListAccountCyclesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const cycles = await db
    .select()
    .from(cardCyclesTable)
    .where(and(eq(cardCyclesTable.accountId, account.id), eq(cardCyclesTable.userId, req.userId)))
    .orderBy(cardCyclesTable.cycleStart);
  res.json(ListAccountCyclesResponse.parse(cycles.map(serializeCycle)));
});

router.post("/accounts/:id/generate-cycles", async (req, res): Promise<void> => {
  const params = GenerateAccountCyclesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const account = await ownedAccount(params.data.id, req.userId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const cycles = await generateCyclesForAccount(account.id);
  await regenerateForecastForUser(req.userId);
  res.json(GenerateAccountCyclesResponse.parse(cycles.map(serializeCycle)));
});

function serialize(a: typeof accountsTable.$inferSelect) {
  return {
    ...a,
    currentBalance: parseFloat(String(a.currentBalance)),
    monthlyContribution: parseFloat(String(a.monthlyContribution)),
    savingsGoal: a.savingsGoal != null ? parseFloat(String(a.savingsGoal)) : null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
    // Soft-unlink (disconnect / item removal) nulls plaid_account_id but
    // leaves plaid_subtype behind; manually created accounts never have a
    // plaid_subtype. That residue is the only signal that a MANUAL account
    // used to be bank-linked.
    wasPlaidLinked: a.plaidAccountId == null && a.plaidSubtype != null,
    availableBalance: a.availableBalance != null ? parseFloat(String(a.availableBalance)) : null,
    minimumPayment: a.minimumPayment != null ? parseFloat(String(a.minimumPayment)) : null,
    lastStatementBalance: a.lastStatementBalance != null ? parseFloat(String(a.lastStatementBalance)) : null,
    lastPaymentAmount: a.lastPaymentAmount != null ? parseFloat(String(a.lastPaymentAmount)) : null,
    fixedPaymentAmount: a.fixedPaymentAmount != null ? parseFloat(String(a.fixedPaymentAmount)) : null,
    paymentSuggestionDismissedAt: a.paymentSuggestionDismissedAt ? a.paymentSuggestionDismissedAt.toISOString() : null,
  };
}

export default router;
