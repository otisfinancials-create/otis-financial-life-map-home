import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { CountryCode, Products, DepositoryAccountSubtype, CreditAccountSubtype, InvestmentAccountSubtype } from "plaid";
import { db, accountsTable, plaidItemsTable, plaidTransactionsTable } from "@workspace/db";
import {
  CreatePlaidLinkTokenBody,
  CreatePlaidLinkTokenResponse,
  RefreshPlaidItemAccountsParams,
  RefreshPlaidItemAccountsResponse,
  ExchangePlaidTokenBody,
  ExchangePlaidTokenResponse,
  DisconnectPlaidAccountBody,
  DisconnectPlaidAccountResponse,
  SyncPlaidTransactionsResponse,
  ListPlaidTransactionsResponse,
  RemovePlaidItemParams,
  RemovePlaidItemResponse,
  SetPlaidForecastAccountsBody,
  SetPlaidForecastAccountsResponse,
} from "@workspace/api-zod";
import { plaidClient, mapPlaidAccountType } from "../lib/plaid";
import { syncAllItemsForUser } from "../services/plaid-sync";
import { removePlaidItem, PlaidRemovalError } from "../services/plaid-item-removal";

const router: IRouter = Router();

router.post("/plaid/create-link-token", async (req, res): Promise<void> => {
  const parsed = CreatePlaidLinkTokenBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const plaidItemId = parsed.data?.plaidItemId ?? null;

  // Update mode: the item's access token puts Link in update mode; account
  // selection lets the user add accounts under the already-connected bank.
  let updateAccessToken: string | null = null;
  if (plaidItemId != null) {
    const [item] = await db
      .select({ accessToken: plaidItemsTable.accessToken })
      .from(plaidItemsTable)
      .where(and(eq(plaidItemsTable.id, plaidItemId), eq(plaidItemsTable.userId, req.userId)));
    if (!item) {
      // Never trust a client-supplied item id: wrong owner (or nonexistent) → 403.
      res.status(403).json({ error: "Item does not belong to this user" });
      return;
    }
    updateAccessToken = item.accessToken;
  }

  req.log.info({ updateMode: updateAccessToken != null }, "Creating Plaid link token");
  try {
    const shared = {
      user: { client_user_id: req.userId },
      client_name: "Otis Financial",
      // Kept in update mode too: with account_selection_enabled, filters
      // constrain the picker to the same subtypes we support at new-link
      // time, so users can't add account types the app filters out.
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
    };
    const response = await plaidClient.linkTokenCreate(
      updateAccessToken != null
        ? {
            ...shared,
            // Update mode: do NOT re-send products (Transactions is already
            // enabled on the item; re-sending changes request semantics) and
            // no transactions.days_requested (only meaningful at new-link).
            access_token: updateAccessToken,
            update: { account_selection_enabled: true },
          }
        : {
            ...shared,
            products: [Products.Transactions],
            optional_products: [Products.Liabilities, Products.Investments, Products.Identity],
            // Pull up to 2 years of history on new links (institutions may cap
            // lower on their side, e.g. Capital One's 90-day limit).
            transactions: { days_requested: 730 },
          },
    );
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
        // Never clobber the user's forecast-account choice on relink.
        await db.update(accountsTable).set(values).where(eq(accountsTable.id, existing.id));
      } else {
        // Connect-time default: checking accounts pay bills → in the forecast
        // pool; everything else (savings, money market, …) opt-in; credit
        // cards are NEVER forecast accounts. Conflict-safe under the
        // (user_id, plaid_account_id) unique constraint.
        const [inserted] = await db
          .insert(accountsTable)
          .values({
            ...values,
            userId: req.userId,
            isForecastAccount: accountType === "checking",
          })
          .onConflictDoNothing({ target: [accountsTable.userId, accountsTable.plaidAccountId] })
          .returning({ id: accountsTable.id });
        if (inserted) accountsAdded++;
      }
    }

    // Return this item's accounts so the client can show the connect-time
    // "Which accounts do you pay bills from?" selection step.
    const itemAccounts = await db
      .select({
        id: accountsTable.id,
        accountName: accountsTable.accountName,
        accountType: accountsTable.accountType,
        accountNumberLast4: accountsTable.accountNumberLast4,
        isForecastAccount: accountsTable.isForecastAccount,
      })
      .from(accountsTable)
      .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidItemId, item.id)));

    req.log.info({ plaidItemRow: item.id, accountsAdded }, "Plaid item linked");
    res.json(
      ExchangePlaidTokenResponse.parse({
        success: true,
        itemId: item.id,
        institutionName: institutionName ?? "your bank",
        accountsAdded,
        accounts: itemAccounts,
      }),
    );
  } catch (err) {
    req.log.error({ err: sanitizePlaidError(err) }, "Plaid token exchange failed");
    res.status(502).json({ error: "Failed to connect your bank" });
  }
});

// Connect-time (and later) selection of which of an item's accounts pay
// bills — i.e. feed the forecast. Credit cards are NEVER forecast accounts:
// they are ignored regardless of the ids submitted.
router.put("/plaid/forecast-accounts", async (req, res): Promise<void> => {
  const parsed = SetPlaidForecastAccountsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { itemId, selectedAccountIds } = parsed.data;
  const [item] = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(and(eq(plaidItemsTable.id, itemId), eq(plaidItemsTable.userId, req.userId)));
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  const itemAccounts = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidItemId, itemId)));
  const selected = new Set(selectedAccountIds);
  let updated = 0;
  for (const a of itemAccounts) {
    const desired = a.accountType !== "credit_card" && selected.has(a.id);
    if (a.isForecastAccount !== desired) {
      await db.update(accountsTable).set({ isForecastAccount: desired, updatedAt: new Date() }).where(eq(accountsTable.id, a.id));
      updated++;
    }
  }
  const after = await db
    .select({
      id: accountsTable.id,
      accountName: accountsTable.accountName,
      accountType: accountsTable.accountType,
      accountNumberLast4: accountsTable.accountNumberLast4,
      isForecastAccount: accountsTable.isForecastAccount,
    })
    .from(accountsTable)
    .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidItemId, itemId)));
  res.json(SetPlaidForecastAccountsResponse.parse({ updated, accounts: after }));
});

/**
 * Post-update-mode reconciliation. Update mode never issues a new access
 * token, so we do NOT exchange the public token or touch plaid_items —
 * we re-fetch the item's accounts and reconcile by plaid_account_id:
 *   - known plaid_account_id  → update in place (accounts.id unchanged;
 *     bills.payment_account_id and card-cycle FKs stay valid)
 *   - new plaid_account_id    → insert with isForecastAccount=false
 *     (credit cards can never be true anyway)
 *   - row no longer returned  → unlink (plaid fields nulled, row kept as a
 *     manual account) — never deleted, bills may reference it.
 */
router.post("/plaid/items/:id/refresh-accounts", async (req, res): Promise<void> => {
  const parsed = RefreshPlaidItemAccountsParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(and(eq(plaidItemsTable.id, parsed.data.id), eq(plaidItemsTable.userId, req.userId)));
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  try {
    const accountsResponse = await plaidClient.accountsGet({ access_token: item.accessToken });
    const remote = accountsResponse.data.accounts;
    const remoteIds = new Set(remote.map((a) => a.account_id));

    const existingRows = await db
      .select({
        id: accountsTable.id,
        plaidAccountId: accountsTable.plaidAccountId,
        accountName: accountsTable.accountName,
        accountType: accountsTable.accountType,
        accountNumberLast4: accountsTable.accountNumberLast4,
        isForecastAccount: accountsTable.isForecastAccount,
      })
      .from(accountsTable)
      .where(and(eq(accountsTable.userId, req.userId), eq(accountsTable.plaidItemId, item.id)));
    const byPlaidId = new Map(existingRows.map((r) => [r.plaidAccountId, r.id]));

    const now = new Date();
    const newAccountIds: number[] = [];
    for (const acct of remote) {
      const { accountType, isAsset } = mapPlaidAccountType(acct.type, acct.subtype);
      const values = {
        accountName: acct.name || acct.official_name || "Account",
        accountType,
        isAsset,
        institutionName: item.institutionName ?? "Bank",
        currentBalance: String(acct.balances.current ?? 0),
        availableBalance: acct.balances.available != null ? String(acct.balances.available) : null,
        accountNumberLast4: acct.mask ?? null,
        plaidAccountId: acct.account_id,
        plaidItemId: item.id,
        lastSyncedAt: now,
        updatedAt: now,
      };
      const existingId = byPlaidId.get(acct.account_id);
      if (existingId != null) {
        // In place — id must not change; forecast choice never clobbered.
        await db.update(accountsTable).set(values).where(eq(accountsTable.id, existingId));
      } else {
        // Race-safe under concurrent refreshes: the (user_id, plaid_account_id)
        // unique constraint + do-nothing means only one request inserts; the
        // returning row is present only for the actual inserter.
        const [inserted] = await db
          .insert(accountsTable)
          .values({ ...values, userId: req.userId, isForecastAccount: false })
          .onConflictDoNothing({ target: [accountsTable.userId, accountsTable.plaidAccountId] })
          .returning({ id: accountsTable.id });
        if (inserted) newAccountIds.push(inserted.id);
      }
    }

    // Accounts Plaid no longer returns: keep the row (bills/card cycles may
    // reference it), just unlink it so it becomes a manual account — same
    // mechanism as the explicit "Disconnect from Plaid" action.
    // isForecastAccount is reset to false: an unlinked account contributes
    // nothing to the forecast basis, and a stale true would silently rejoin
    // the basis on a later relink. Re-selection must be an explicit choice.
    // The response reports the PRE-unlink flag so the UI can warn about lost
    // forecast basis.
    const unlinkedAccounts: Array<{
      id: number;
      accountName: string;
      accountType: string;
      accountNumberLast4: string | null;
      isForecastAccount: boolean;
    }> = [];
    for (const row of existingRows) {
      if (row.plaidAccountId && !remoteIds.has(row.plaidAccountId)) {
        await db
          .update(accountsTable)
          .set({
            plaidAccountId: null,
            plaidItemId: null,
            availableBalance: null,
            lastSyncedAt: null,
            isForecastAccount: false,
            updatedAt: now,
          })
          .where(eq(accountsTable.id, row.id));
        unlinkedAccounts.push({
          id: row.id,
          accountName: row.accountName,
          accountType: row.accountType,
          accountNumberLast4: row.accountNumberLast4,
          isForecastAccount: row.isForecastAccount,
        });
      }
    }
    const accountsUnlinked = unlinkedAccounts.length;

    const newAccounts = newAccountIds.length
      ? await db
          .select({
            id: accountsTable.id,
            accountName: accountsTable.accountName,
            accountType: accountsTable.accountType,
            accountNumberLast4: accountsTable.accountNumberLast4,
            isForecastAccount: accountsTable.isForecastAccount,
          })
          .from(accountsTable)
          .where(and(eq(accountsTable.userId, req.userId), inArray(accountsTable.id, newAccountIds)))
      : [];

    req.log.info(
      { plaidItemRow: item.id, accountsAdded: newAccountIds.length, accountsUnlinked },
      "Plaid update-mode account reconciliation complete",
    );
    res.json(
      RefreshPlaidItemAccountsResponse.parse({
        success: true,
        itemId: item.id,
        institutionName: item.institutionName ?? "your bank",
        accountsAdded: newAccountIds.length,
        accountsUnlinked,
        newAccounts,
        unlinkedAccounts,
      }),
    );
  } catch (err) {
    req.log.error({ err: sanitizePlaidError(err) }, "Plaid update-mode account refresh failed");
    res.status(502).json({ error: "Failed to refresh your bank's accounts" });
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

/**
 * Remove a Plaid Item completely: revoke at Plaid (/item/remove) and delete
 * all local data derived from it — transactions, balance snapshots, and the
 * card-cycle/allocation data of the accounts it backed. Linked accounts are
 * kept but unlinked (become manual). Idempotent: an already-removed item
 * returns { removed: false }.
 */
router.post("/plaid/items/:id/remove", async (req, res): Promise<void> => {
  const parsed = RemovePlaidItemParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await removePlaidItem(req.userId, parsed.data.id);
    res.json(RemovePlaidItemResponse.parse({ removed: result === "removed" }));
  } catch (err) {
    if (err instanceof PlaidRemovalError) {
      req.log.error({ plaidCode: err.plaidCode, message: err.message }, "Plaid /item/remove failed");
      res.status(502).json({ error: "Plaid rejected the removal; nothing was deleted locally" });
      return;
    }
    throw err;
  }
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
    .set({
      plaidAccountId: null,
      plaidItemId: null,
      availableBalance: null,
      lastSyncedAt: null,
      // Same rule as update-mode unlink: a manual account has no forecast
      // basis, and a stale true would silently rejoin on a later relink.
      isForecastAccount: false,
      updatedAt: new Date(),
    })
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
