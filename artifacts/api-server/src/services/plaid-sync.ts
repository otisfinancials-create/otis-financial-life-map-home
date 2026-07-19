import { eq } from "drizzle-orm";
import { db, plaidItemsTable, plaidTransactionsTable, type PlaidItem } from "@workspace/db";
import type { Transaction } from "plaid";
import { plaidClient } from "../lib/plaid";
import { logger } from "../lib/logger";

export interface SyncCounts {
  added: number;
  modified: number;
  removed: number;
}

/** Sync transactions for a single plaid_items row using /transactions/sync with cursor pagination. */
export async function syncTransactionsForItem(item: PlaidItem): Promise<SyncCounts> {
  let cursor = item.transactionsCursor ?? undefined;
  let hasMore = true;
  const counts: SyncCounts = { added: 0, modified: 0, removed: 0 };

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
  }

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
  const totals: SyncCounts = { added: 0, modified: 0, removed: 0 };
  for (const item of items) {
    const c = await syncTransactionsForItem(item);
    totals.added += c.added;
    totals.modified += c.modified;
    totals.removed += c.removed;
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
