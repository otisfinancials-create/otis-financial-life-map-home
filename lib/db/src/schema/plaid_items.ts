import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("plaid_items_user_item_unique").on(t.userId, t.itemId)]);

export type PlaidItem = typeof plaidItemsTable.$inferSelect;
