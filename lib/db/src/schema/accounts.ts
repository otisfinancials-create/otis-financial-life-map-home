import { pgTable, serial, text, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountName: text("account_name").notNull(),
  accountType: text("account_type").notNull(),
  institutionName: text("institution_name").notNull(),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
  isAsset: boolean("is_asset").notNull().default(true),
  plaidAccountId: text("plaid_account_id"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true, userId: true, createdAt: true, plaidAccountId: true, lastSyncedAt: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
