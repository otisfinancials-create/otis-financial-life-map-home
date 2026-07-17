import { pgTable, serial, text, numeric, boolean, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forecastedTransactionsTable = pgTable("forecasted_transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  transactionDate: date("transaction_date", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  transactionType: text("transaction_type").notNull(),
  category: text("category").notNull(),
  sourceBillId: integer("source_bill_id"),
  sourcePayId: integer("source_pay_id"),
  sourceLifeEventId: integer("source_life_event_id"),
  sourceBalanceSyncId: integer("source_balance_sync_id"),
  // Credit-card billing cycle grouping (manual version — Plaid will automate
  // this in a future phase). ccAccountId links a row to a credit_card account.
  // isCcParent=true marks the "Credit Card Payment" row (starts at $0 and
  // increments as its child rows are marked paid); children carry the bill
  // amounts but do not affect the running balance.
  ccAccountId: integer("cc_account_id"),
  isCcParent: boolean("is_cc_parent").notNull().default(false),
  isActual: boolean("is_actual").notNull().default(false),
  isCommitted: boolean("is_committed").notNull().default(false),
  // 'missed' = past bill the user marked as not paid; excluded from running balance.
  status: text("status"),
  notes: text("notes"),
  // Original planned amount, kept when the user confirms a different actual amount.
  forecastedAmount: numeric("forecasted_amount", { precision: 12, scale: 2 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertForecastedTransactionSchema = createInsertSchema(forecastedTransactionsTable).omit({ id: true, userId: true, createdAt: true });
export type InsertForecastedTransaction = z.infer<typeof insertForecastedTransactionSchema>;
export type ForecastedTransaction = typeof forecastedTransactionsTable.$inferSelect;
