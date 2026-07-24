import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { CountryCode, Products, DepositoryAccountSubtype, CreditAccountSubtype, InvestmentAccountSubtype } from "plaid";
import { db, accountsTable, plaidItemsTable, plaidTransactionsTable } from "@workspace/db";
import {
  CreatePlaidLinkTokenResponse,
  ExchangePlaidTokenBody,
  ExchangePlaidTokenResponse,
  DisconnectPlaidAccountBody,
  DisconnectPlaidAccountResponse,
  SyncPlaidTransactionsResponse,
  ListPlaidTransactionsResponse,
} from "@workspace/api-zod";
import { plaidClient, mapPlaidAccountType } from "../lib/plaid";
import { syncAllItemsForUser } from "../services/plaid-sync";

const router: IRouter = Router();

router.post("/plaid/create-link-token", async (req, res): Promise<void> => {
  req.log.info("Creating Plaid link token");
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.userId },
      client_name: "Otis Financial",
      products: [Products.Transactions],
      optional_products: [Products.Liabilities, Products.Investments, Products.Identity],
      account_filters: {
        depository: {
          account_subtypes: [DepositoryAccountSubtype.Checking, DepositoryAccountSubtype.Savings],
        },
        credit: {
          account_subtypes: [CreditAccountSubtype.CreditCard],
        },
        investment: {
          account_subtypes: [InvestmentAccountSubtype.All],
        },
      },
      country_codes: [CountryCode.Us],
      language: "en",
      ...(process.env["REPLIT_DOMAINS"]
        ? { webhook: `https://${process.env["REPLIT_DOMAINS"].split(",")[0]}/api/plaid/webhook` }
        : {}),
    });
    res.json(CreatePlaidLinkTokenResponse.parse({ linkToken: response.data.link_token }));
  } catch (err) {
    req.log.error({ err: sanitizePlaidError(err) }, "Plaid link token creation failed");
    res.status(502).json({ error: "Failed to initialize bank connection" });
  }
});

router.post("/plaid/exchange-token", async (req, res): Promise<void> => {
  const parsed = ExchangePlaidTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  req.log.info("Exchanging Plaid public token");
  try {
    const exchange = await plaidClient.itemPublicTokenExchange({
      public_token: parsed.data.publicToken,
    });
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;

    // Resolve institution details (name + logo) if we have an id.
    let institutionId = parsed.data.institutionId ?? null;
    let institutionName = parsed.data.institutionName ?? null;
    let institutionLogo: string | null = null;
    if (!institutionId) {
      const item = await plaidClient.itemGet({ access_token: accessToken });
      institutionId = item.data.item.institution_id ?? null;
    }
    if (institutionId) {
      try {
        const inst = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
          options: { include_optional_metadata: true },
        });
        institutionName = inst.data.institution.name;
        institutionLogo = inst.data.institution.logo ?? null;
      } catch {
        // Logo/name lookup is best-effort.
      }
    }

    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: req.userId,
        accessToken,
        itemId: plaidItemId,
        institutionId,
        institutionName,
        institutionLogo,
      })
      .onConflictDoUpdate({
        target: [plaidItemsTable.userId, plaidItemsTable.itemId],
        set: { accessToken, institutionId, institutionName, institutionLogo, updatedAt: new Date() },
      })
      .returning({ id: plaidItemsTable.id });

    // Fetch and upsert accounts.
    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const now = new Date();
    let accountsAdded = 0;
    for (const acct of accountsResponse.data.accounts) {
      const { accountType, isAsset } = mapPlaidAccountType(acct.type, acct.subtype);
      const values = {
        accountName: acct.name || acct.official_name || "Account",
        accountType,
        isAsset,
        institutionName: institutionName ?? "Bank",
        currentBalance: String(acct.balances.current ?? 0),
        availableBalance: acct.balances.available != null ? String(acct.balances.available) : null,
        accountNumberLast4: acct.mask ?? null,
        plaidAccountId: acct.account_id,
        plaidItemId: item.id,
        lastSyncedAt: now,
        updatedAt: now,
      };
      const [existing] = await db
        .select({ id: accountsTable.id })
        .from(accountsTable)
        .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidAccountId, acct.account_id)));
      if (existing) {
        await db.update(accountsTable).set(values).where(eq(accountsTable.id, existing.id));
      } else {
        await db.insert(accountsTable).values({ ...values, userId: req.userId });
        accountsAdded++;
      }
    }

    req.log.info({ plaidItemRow: item.id, accountsAdded }, "Plaid item linked");
    res.json(
      ExchangePlaidTokenResponse.parse({
        success: true,
        itemId: item.id,
        institutionName: institutionName ?? "your bank",
        accountsAdded,
      }),
    );
  } catch (err) {
    req.log.error({ err: sanitizePlaidError(err) }, "Plaid token exchange failed");
    res.status(502).json({ error: "Failed to connect your bank" });
  }
});

router.post("/plaid/sync", async (req, res): Promise<void> => {
  req.log.info("Manual Plaid transaction sync requested");
  try {
    const counts = await syncAllItemsForUser(req.userId);
    res.json(
      SyncPlaidTransactionsResponse.parse({
        added: counts.added,
        modified: counts.modified,
        removed: counts.removed,
        balancesCaptured: counts.balances_captured,
        lastSyncedAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    req.log.error({ err: sanitizePlaidError(err) }, "Plaid transaction sync failed");
    res.status(502).json({ error: "Failed to sync transactions" });
  }
});

router.get("/plaid/transactions", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query["limit"]);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
  const rows = await db
    .select({
      txn: plaidTransactionsTable,
      accountName: accountsTable.accountName,
      accountType: accountsTable.accountType,
    })
    .from(plaidTransactionsTable)
    .leftJoin(accountsTable, eq(accountsTable.plaidAccountId, plaidTransactionsTable.accountId))
    .where(eq(plaidTransactionsTable.userId, req.userId))
    .orderBy(desc(plaidTransactionsTable.date), desc(plaidTransactionsTable.id))
    .limit(limit);
  res.json(
    ListPlaidTransactionsResponse.parse(
      rows.map(({ txn, accountName, accountType }) => ({
        id: txn.id,
        accountId: txn.accountId,
        plaidTransactionId: txn.plaidTransactionId,
        amount: parseFloat(String(txn.amount)),
        date: txn.date,
        name: txn.name,
        merchantName: txn.merchantName,
        category: txn.category,
        personalFinanceCategory: txn.personalFinanceCategory,
        personalFinanceCategoryDetailed: txn.personalFinanceCategoryDetailed,
        paymentChannel: txn.paymentChannel,
        pending: txn.pending,
        transactionType: txn.transactionType,
        currencyCode: txn.currencyCode,
        accountName,
        accountType,
      })),
    ),
  );
});

router.post("/plaid/disconnect", async (req, res): Promise<void> => {
  const parsed = DisconnectPlaidAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.id, parsed.data.accountId), eq(accountsTable.userId, req.userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  await db
    .update(accountsTable)
    .set({ plaidAccountId: null, plaidItemId: null, availableBalance: null, lastSyncedAt: null, updatedAt: new Date() })
    .where(eq(accountsTable.id, account.id));

  await cleanupOrphanedItems(req.userId, req.log);

  req.log.info({ accountId: account.id }, "Plaid connection removed; account kept as manual");
  res.json(DisconnectPlaidAccountResponse.parse({ success: true }));
});

/** Delete any plaid_items for this user that no account references, revoking tokens at Plaid. */
async function cleanupOrphanedItems(userId: string, log: { warn: (obj: object, msg: string) => void }): Promise<void> {
  const items = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.userId, userId));
  const referenced = await db
    .select({ plaidItemId: accountsTable.plaidItemId })
    .from(accountsTable)
    .where(eq(accountsTable.userId, userId));
  const referencedIds = new Set(referenced.map((r) => r.plaidItemId).filter((id) => id != null));
  for (const item of items) {
    if (referencedIds.has(item.id)) continue;
    try {
      await plaidClient.itemRemove({ access_token: item.accessToken });
    } catch (err) {
      log.warn({ err: sanitizePlaidError(err) }, "Plaid itemRemove failed during cleanup");
    }
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.id, item.id));
  }
}

/** Strip anything token-like from Plaid errors before logging. */
function sanitizePlaidError(err: unknown): { message: string; plaidCode?: string } {
  if (err && typeof err === "object" && "response" in err) {
    const resp = (err as { response?: { data?: { error_code?: string; error_message?: string } } }).response;
    return { message: resp?.data?.error_message ?? "Plaid request failed", plaidCode: resp?.data?.error_code };
  }
  return { message: err instanceof Error ? err.message : "Unknown error" };
}

export default router;
