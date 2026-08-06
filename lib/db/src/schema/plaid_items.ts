import { boolean, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * A linked Plaid Item (one bank connection). The access token is sensitive:
 * it must never be returned by any API response or written to logs.
 */
export const plaidItemsTable = pgTable("plaid_items", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accessToken: text("access_token").notNull(),
  itemId: text("item_id").notNull(),
  institutionId: text("institution_id"),
  institutionName: text("institution_name"),
  institutionLogo: text("institution_logo"),
  transactionsCursor: text("transactions_cursor"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  // Sync-attempt tracking: last_synced_at only records SUCCESS, so a failing
  // item was previously indistinguishable from an idle one. Every sync path
  // stamps last_sync_attempted_at at the start; failures store the sanitized
  // error + Plaid code and increment consecutive_failures; success clears them.
  lastSyncAttemptedAt: timestamp("last_sync_attempted_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
  lastSyncErrorCode: text("last_sync_error_code"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  needsReauth: boolean("needs_reauth").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("plaid_items_user_item_unique").on(t.userId, t.itemId)]);

export type PlaidItem = typeof plaidItemsTable.$inferSelect;
