import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  accountsTable,
  plaidItemsTable,
  plaidTransactionsTable,
  balanceSnapshotsTable,
  cardCyclesTable,
  envelopesTable,
  cardCycleBillsTable,
  envelopeAllocationsTable,
} from "@workspace/db";
import { plaidClient } from "../lib/plaid";
import { logger } from "../lib/logger";
import { sanitizeSyncError } from "./plaid-sync";

/** Plaid rejected /item/remove for a reason other than "already gone". */
export class PlaidRemovalError extends Error {
  constructor(public plaidCode: string | undefined, message: string) {
    super(message);
  }
}

/**
 * Remove a Plaid Item completely: revoke at Plaid (/item/remove) and delete
 * all local data derived from it — transactions, balance snapshots, and the
 * card-cycle/allocation data of the accounts it backed. Linked accounts are
 * kept but unlinked (become manual). Idempotent: a missing item returns
 * "not_found"; an item already revoked upstream is still cleaned up locally.
 */
export async function removePlaidItem(userId: string, itemId: number): Promise<"removed" | "not_found"> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(and(eq(plaidItemsTable.id, itemId), eq(plaidItemsTable.userId, userId)));
  if (!item) return "not_found";

  // Revoke at Plaid first. ITEM_NOT_FOUND means it's already gone — proceed.
  try {
    await plaidClient.itemRemove({ access_token: item.accessToken });
  } catch (err) {
    const info = sanitizeSyncError(err);
    if (info.plaidCode !== "ITEM_NOT_FOUND") {
      throw new PlaidRemovalError(info.plaidCode, info.message);
    }
    logger.warn({ plaidItemId: item.id }, "Plaid item already removed upstream; cleaning up locally");
  }

  await db.transaction(async (tx) => {
    // Accounts this item backed → their cycle/allocation data.
    const linkedAccounts = await tx
      .select({ id: accountsTable.id })
      .from(accountsTable)
      .where(and(eq(accountsTable.userId, userId), eq(accountsTable.plaidItemId, item.id)));
    const accountIds = linkedAccounts.map((a) => a.id);

    if (accountIds.length) {
      const cycles = await tx
        .select({ id: cardCyclesTable.id })
        .from(cardCyclesTable)
        .where(inArray(cardCyclesTable.accountId, accountIds));
      const cycleIds = cycles.map((c) => c.id);
      if (cycleIds.length) {
        const envs = await tx
          .select({ id: envelopesTable.id })
          .from(envelopesTable)
          .where(inArray(envelopesTable.cardCycleId, cycleIds));
        const cycleBills = await tx
          .select({ id: cardCycleBillsTable.id })
          .from(cardCycleBillsTable)
          .where(inArray(cardCycleBillsTable.cardCycleId, cycleIds));
        if (envs.length)
          await tx
            .delete(envelopeAllocationsTable)
            .where(inArray(envelopeAllocationsTable.envelopeId, envs.map((e) => e.id)));
        if (cycleBills.length)
          await tx
            .delete(envelopeAllocationsTable)
            .where(inArray(envelopeAllocationsTable.cardCycleBillId, cycleBills.map((b) => b.id)));
        await tx.delete(cardCycleBillsTable).where(inArray(cardCycleBillsTable.cardCycleId, cycleIds));
        await tx.delete(envelopesTable).where(inArray(envelopesTable.cardCycleId, cycleIds));
        await tx.delete(cardCyclesTable).where(inArray(cardCyclesTable.id, cycleIds));
      }
    }

    // Any leftover allocations pointing at this item's Plaid transactions
    // (e.g. against another card's cycle) — plaid_transaction_id has no FK.
    const txnIds = await tx
      .select({ id: plaidTransactionsTable.plaidTransactionId })
      .from(plaidTransactionsTable)
      .where(eq(plaidTransactionsTable.plaidItemId, item.id));
    if (txnIds.length)
      await tx
        .delete(envelopeAllocationsTable)
        .where(inArray(envelopeAllocationsTable.plaidTransactionId, txnIds.map((t) => t.id)));

    await tx.delete(plaidTransactionsTable).where(eq(plaidTransactionsTable.plaidItemId, item.id));
    await tx.delete(balanceSnapshotsTable).where(eq(balanceSnapshotsTable.plaidItemId, item.id));

    // Keep the account rows (bills/forecasts may reference them) but unlink.
    if (accountIds.length)
      await tx
        .update(accountsTable)
        .set({
          plaidAccountId: null,
          plaidItemId: null,
          availableBalance: null,
          lastSyncedAt: null,
          updatedAt: new Date(),
        })
        .where(inArray(accountsTable.id, accountIds));

    await tx.delete(plaidItemsTable).where(eq(plaidItemsTable.id, item.id));
  });

  logger.info({ plaidItemId: item.id, institution: item.institutionName }, "Plaid item removed");
  return "removed";
}
