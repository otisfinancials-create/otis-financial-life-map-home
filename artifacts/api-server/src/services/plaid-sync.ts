import { eq, and, sql } from "drizzle-orm";
import { db, plaidItemsTable, plaidTransactionsTable, balanceSnapshotsTable, forecastedTransactionsTable, type PlaidItem } from "@workspace/db";
import type { Transaction, AccountBase } from "plaid";
import { plaidClient } from "../lib/plaid";
import { detectBills } from "./bill-detection";
import { syncLiabilitiesForItem } from "./plaid-liabilities";
import { rollActualsForUser } from "./actuals-roll";
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
  let lastUpdateStatus: string | undefined;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: item.accessToken,
      cursor,
      count: 100,
    });
    const data = response.data;

    for (const txn of [...data.added, ...data.modified]) {
      await upsertTransaction(item.userId, item.id, txn);
      // A pending transaction the user reconciled a planned row against may
      // settle under a NEW Plaid id (pending_transaction_id points back at
      // it). Remap the reconciliation link to the settled transaction and
      // update the row to the settled amount/date, so the link survives the
      // pending row's removal and the cash event still counts exactly once.
      if (txn.pending_transaction_id) {
        await remapReconciledLink(item.userId, txn.pending_transaction_id, txn);
      }
    }
    counts.added += data.added.length;
    counts.modified += data.modified.length;

    for (const removed of data.removed) {
      if (removed.transaction_id) {
        // If a reconciled forecast row still links to this transaction (a
        // pending charge that was cancelled rather than settled), revert the
        // row to planned before deleting — otherwise it would keep stepping
        // the balance for money that never moved.
        await revertOrphanedLinks(item.userId, removed.transaction_id);
        await db
          .delete(plaidTransactionsTable)
          .where(eq(plaidTransactionsTable.plaidTransactionId, removed.transaction_id));
        counts.removed++;
      }
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
    latestAccounts = data.accounts;
    lastUpdateStatus = data.transactions_update_status;

    if (
      !hasMore &&
      isInitialSync &&
      lastUpdateStatus !== "HISTORICAL_UPDATE_COMPLETE"
    ) {
      if (historicalWaitAttempts >= MAX_HISTORICAL_WAIT_ATTEMPTS) {
        // Give up waiting; the guard below will refuse to persist the cursor,
        // so the next sync retries from scratch.
        break;
      }
      historicalWaitAttempts++;
      hasMore = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // P4: capture end-of-day balances for every account on this item via
  // /accounts/get (cached balances, free — NOT the paid /accounts/balance/get).
  // transactionsSync only includes accounts that had transactions in the batch,
  // so relying on it left inactive accounts with frozen balances.
  let balanceAccounts = latestAccounts;
  try {
    const accountsResponse = await plaidClient.accountsGet({ access_token: item.accessToken });
    balanceAccounts = accountsResponse.data.accounts;
  } catch (err) {
    logger.warn(
      { plaidItemId: item.id, err: sanitizeSyncError(err) },
      "Plaid /accounts/get failed; falling back to transactionsSync accounts for balance capture",
    );
  }
  try {
    counts.balances_captured = await captureBalanceSnapshots(item, balanceAccounts);
  } catch (err) {
    // Never fail the sync over balance persistence; transactions are already saved.
    counts.balances_captured = 0;
    logger.warn(
      { plaidItemId: item.id, err: sanitizeSyncError(err) },
      "Failed to persist balance snapshots; continuing sync",
    );
  }

  // Refresh Plaid Liabilities data (card minimums, statement balances, next
  // due dates) so cycle days stay current cycle over cycle. Best-effort
  // inside the service — unsupported institutions never fail the sync.
  await syncLiabilitiesForItem(item);

  // Hard guard (all syncs, not just initial): never persist a cursor while
  // Plaid reports the historical backfill is still pending. Persisting one
  // would permanently skip the item's history.
  if (lastUpdateStatus !== "HISTORICAL_UPDATE_COMPLETE") {
    logger.warn(
      { plaidItemId: item.id, status: lastUpdateStatus, isInitialSync },
      "Plaid sync: historical update not complete; cursor not saved (will retry next sync)",
    );
    return counts;
  }

  await db
    .update(plaidItemsTable)
    .set({ transactionsCursor: cursor ?? null, lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(plaidItemsTable.id, item.id));

  logger.info(
    { plaidItemId: item.id, ...counts },
    "Plaid transaction sync complete for item",
  );

  // Ongoing detection: new history can surface new recurring bills. detectBills
  // is idempotent (upsert + stale-pending cleanup), so re-running is safe; only
  // genuinely new detections are inserted unseen and trigger the login notice.
  if (counts.added > 0 || counts.modified > 0 || counts.removed > 0) {
    scheduleDetection(item.userId);
  }
  return counts;
}

// Coalesce post-sync detection per user: multi-item users, nightly loops, and
// webhook bursts would otherwise run several full detection passes back to
// back. A short trailing timer runs detection once after the burst settles.
const DETECTION_COALESCE_MS = 5_000;
const pendingDetection = new Map<string, NodeJS.Timeout>();

function scheduleDetection(userId: string): void {
  const existing = pendingDetection.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingDetection.delete(userId);
    detectBills(userId)
      .catch((err) => {
        logger.error({ userId, err: sanitizeSyncError(err) }, "Post-sync bill detection failed");
      })
      // P6 part 2: after detection, refresh the forecast past — resolve stale
      // planned rows and rebuild unplanned actual buckets from new postings.
      // Runs even when detection failed: the roll must always reflect the
      // latest posted transactions (including removals).
      .then(() => rollActualsForUser(userId), () => rollActualsForUser(userId))
      .catch((err) => {
        logger.error({ userId, err: sanitizeSyncError(err) }, "Post-sync actuals roll failed");
      });
  }, DETECTION_COALESCE_MS);
  timer.unref?.();
  pendingDetection.set(userId, timer);
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

/** Move a reconciliation link from a settled-away pending transaction to its
 * settled replacement, updating the row to the settled amount/date. */
async function remapReconciledLink(userId: string, pendingPlaidTxnId: string, settled: Transaction): Promise<void> {
  const [pendingRow] = await db
    .select({ id: plaidTransactionsTable.id })
    .from(plaidTransactionsTable)
    .where(eq(plaidTransactionsTable.plaidTransactionId, pendingPlaidTxnId));
  if (!pendingRow) return;
  const [settledRow] = await db
    .select({ id: plaidTransactionsTable.id })
    .from(plaidTransactionsTable)
    .where(eq(plaidTransactionsTable.plaidTransactionId, settled.transaction_id));
  if (!settledRow) return;
  const updated = await db
    .update(forecastedTransactionsTable)
    .set({
      matchedPlaidTransactionId: settledRow.id,
      transactionDate: settled.date,
      amount: String(Math.abs(settled.amount)),
    })
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.matchedPlaidTransactionId, pendingRow.id),
    ))
    .returning({ id: forecastedTransactionsTable.id });
  if (updated.length > 0) {
    logger.info({ userId, pendingPlaidTxnId, settledId: settledRow.id, rows: updated.map((r) => r.id) }, "Remapped reconciled link from pending to settled transaction");
  }
}

/** A linked transaction is being deleted (cancelled pending): revert any
 * reconciled forecast rows to their planned state. */
async function revertOrphanedLinks(userId: string, plaidTxnId: string): Promise<void> {
  const [txnRow] = await db
    .select({ id: plaidTransactionsTable.id })
    .from(plaidTransactionsTable)
    .where(eq(plaidTransactionsTable.plaidTransactionId, plaidTxnId));
  if (!txnRow) return;
  const linked = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.matchedPlaidTransactionId, txnRow.id),
    ));
  for (const row of linked) {
    if (row.isUnplanned) {
      // Derived rows are rebuilt by the roll; just delete.
      await db.delete(forecastedTransactionsTable).where(eq(forecastedTransactionsTable.id, row.id));
      continue;
    }
    await db
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
      .where(eq(forecastedTransactionsTable.id, row.id));
    logger.info({ userId, plaidTxnId, forecastRowId: row.id }, "Reverted reconciled row: linked pending transaction was removed");
  }
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
