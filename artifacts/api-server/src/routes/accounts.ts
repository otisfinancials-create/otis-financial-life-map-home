import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, accountsTable, savingsSnapshotsTable } from "@workspace/db";
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
} from "@workspace/api-zod";

const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "brokerage"];

const router: IRouter = Router();

router.get("/accounts", async (req, res): Promise<void> => {
  req.log.info("Fetching accounts");
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId))
    .orderBy(accountsTable.accountType, accountsTable.accountName);
  res.json(ListAccountsResponse.parse(accounts.map(serialize)));
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
  const [account] = await db
    .delete(accountsTable)
    .where(and(eq(accountsTable.id, params.data.id), eq(accountsTable.userId, req.userId)))
    .returning();
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  res.sendStatus(204);
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
  };
}

export default router;
