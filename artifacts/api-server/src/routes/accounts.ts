import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";
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
} from "@workspace/api-zod";

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
  }).returning();
  res.status(201).json(CreateAccountResponse.parse(serialize(account)));
});

router.get("/accounts/summary", async (req, res): Promise<void> => {
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.userId, req.userId));

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
  const { currentBalance: rawBalance, ...restAccountData } = parsed.data;
  const [account] = await db
    .update(accountsTable)
    .set({
      ...restAccountData,
      ...(rawBalance !== undefined && { currentBalance: String(rawBalance) }),
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
    createdAt: a.createdAt.toISOString(),
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
  };
}

export default router;
