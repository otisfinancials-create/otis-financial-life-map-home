import { eq, sql } from "drizzle-orm";
import { db, plaidItemsTable, plaidTransactionsTable, balanceSnapshotsTable, type PlaidItem } from "@workspace/db";
import type { Transaction, AccountBase } from "plaid";
import { plaidClient } from "../lib/plaid";
import { logger } from "../lib/logger";

export interface SyncCounts {
  added: number;
  modified: number;
  removed: number;
  balances_captured: number;
}

/** Sync transactions for a single plaid_items row using /transactions/sync with cursor pagination. */
export async function syncTransactionsForItem(item: PlaidItem): Promise<SyncCounts> {
  let cursor = item.transactionsCursor ?? undefined;
  const isInitialSync = cursor === undefined;
  let hasMore = true;
  const counts: SyncCounts = { added: 0, modified: 0, removed: 0, balances_captured: 0 };
  let latestAccounts: AccountBase[] | undefined;
  // On an initial sync, Plaid may report has_more=false before the historical
  // backfill finishes. Saving that cursor would permanently skip history, so we
  // poll (bounded) until transactions_update_status is HISTORICAL_UPDATE_COMPLETE.
  let historicalWaitAttempts = 0;
  const MAX_HISTORICAL_WAIT_ATTEMPTS = 30;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: item.accessToken,
      cursor,
      count: 100,
    });
    const data = response.data;

    for (const txn of [...data.added, ...data.modified]) {
      await upsertTransaction(item.userId, item.id, txn);
    }
    counts.added += data.added.length;
    counts.modified += data.modified.length;

    for (const removed of data.removed) {
      if (removed.transaction_id) {
        await db
          .delete(plaidTransactionsTable)
          .where(eq(plaidTransactionsTable.plaidTransactionId, removed.transaction_id));
        counts.removed++;
      }
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
    latestAccounts = data.accounts;

    if (
      !hasMore &&
      isInitialSync &&
      data.transactions_update_status !== "HISTORICAL_UPDATE_COMPLETE"
    ) {
      if (historicalWaitAttempts >= MAX_HISTORICAL_WAIT_ATTEMPTS) {
        // Give up waiting; do NOT persist the cursor so the next sync retries from scratch.
        logger.warn(
          { plaidItemId: item.id, status: data.transactions_update_status },
          "Initial Plaid sync: historical update did not complete in time; cursor not saved",
        );
        return counts;
      }
      historicalWaitAttempts++;
      hasMore = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // P4: capture end-of-day balances from the final transactionsSync response (no extra Plaid call).
  counts.balances_captured = await captureBalanceSnapshots(item, latestAccounts);

  await db
    .update(plaidItemsTable)
    .set({ transactionsCursor: cursor ?? null, lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(plaidItemsTable.id, item.id));

  logger.info(
    { plaidItemId: item.id, ...counts },
    "Plaid transaction sync complete for item",
  );
  return counts;
}

/** Upsert one balance_snapshots row per account for today (last write wins for the day). */
async function captureBalanceSnapshots(item: PlaidItem, accounts: AccountBase[] | undefined): Promise<number> {
  if (!accounts || accounts.length === 0) {
    return 0;
  }
  // Server local date, YYYY-MM-DD
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let captured = 0;
  for (const acct of accounts) {
    const values = {
      userId: item.userId,
      plaidItemId: item.id,
      accountId: acct.account_id,
      snapshotDate: today,
      current: acct.balances?.current != null ? String(acct.balances.current) : null,
      available: acct.balances?.available != null ? String(acct.balances.available) : null,
      creditLimit: acct.balances?.limit != null ? String(acct.balances.limit) : null,
      currencyCode: acct.balances?.iso_currency_code ?? "USD",
    };
    await db
      .insert(balanceSnapshotsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [balanceSnapshotsTable.accountId, balanceSnapshotsTable.snapshotDate],
        set: {
          current: values.current,
          available: values.available,
          creditLimit: values.creditLimit,
          currencyCode: values.currencyCode,
          capturedAt: sql`now()`,
        },
      });
    captured++;
  }
  return captured;
}

async function upsertTransaction(userId: string, plaidItemId: number, txn: Transaction): Promise<void> {
  const values = {
    userId,
    plaidItemId,
    accountId: txn.account_id,
    plaidTransactionId: txn.transaction_id,
    amount: String(txn.amount),
    date: txn.date,
    name: txn.name ?? null,
    merchantName: txn.merchant_name ?? null,
    category: txn.category ?? null,
    personalFinanceCategory: txn.personal_finance_category?.primary ?? null,
    personalFinanceCategoryDetailed: txn.personal_finance_category?.detailed ?? null,
    paymentChannel: txn.payment_channel ?? null,
    pending: txn.pending ?? false,
    transactionType: txn.transaction_type ?? null,
    currencyCode: txn.iso_currency_code ?? "USD",
  };
  await db
    .insert(plaidTransactionsTable)
    .values(values)
    .onConflictDoUpdate({
      target: plaidTransactionsTable.plaidTransactionId,
      set: {
        amount: values.amount,
        date: values.date,
        pending: values.pending,
        name: values.name,
        merchantName: values.merchantName,
        category: values.category,
        personalFinanceCategory: values.personalFinanceCategory,
        personalFinanceCategoryDetailed: values.personalFinanceCategoryDetailed,
        paymentChannel: values.paymentChannel,
        updatedAt: new Date(),
      },
    });
}

/** Sync all connected items for one user. */
export async function syncAllItemsForUser(userId: string): Promise<SyncCounts> {
  const items = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.userId, userId));
  const totals: SyncCounts = { added: 0, modified: 0, removed: 0, balances_captured: 0 };
  for (const item of items) {
    const c = await syncTransactionsForItem(item);
    totals.added += c.added;
    totals.modified += c.modified;
    totals.removed += c.removed;
    totals.balances_captured += c.balances_captured;
  }
  return totals;
}

/** Sync every item for every user (nightly job). */
export async function syncAllUsers(): Promise<void> {
  const items = await db.select().from(plaidItemsTable);
  for (const item of items) {
    try {
      await syncTransactionsForItem(item);
    } catch (err) {
      logger.error({ plaidItemId: item.id, err: sanitizeSyncError(err) }, "Plaid nightly sync failed for item");
    }
  }
}

/** Strip anything token-like from Plaid errors before logging. */
export function sanitizeSyncError(err: unknown): { message: string; plaidCode?: string } {
  if (err && typeof err === "object" && "response" in err) {
    const resp = (err as { response?: { data?: { error_code?: string; error_message?: string } } }).response;
    return { message: resp?.data?.error_message ?? "Plaid request failed", plaidCode: resp?.data?.error_code };
  }
  return { message: err instanceof Error ? err.message : "Unknown error" };
}
