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
  // P5 cycle-based card payments: when set, this row IS the card cycle's
  // due-date payment (isCcParent=true, no child rows). ccBasis records how the
  // amount was determined: 'actual' (closed cycle — accumulated_total) or
  // 'projected' (open cycle — max(accumulated, planned)).
  sourceCardCycleId: integer("source_card_cycle_id"),
  ccBasis: text("cc_basis"), // 'actual' | 'projected'
  isActual: boolean("is_actual").notNull().default(false),
  isCommitted: boolean("is_committed").notNull().default(false),
  // 'missed' = past bill the user marked as not paid; excluded from running balance.
  status: text("status"),
  notes: text("notes"),
  // Original planned amount, kept when the user confirms a different actual amount.
  forecastedAmount: numeric("forecasted_amount", { precision: 12, scale: 2 }),
  // P6 bank-paid bill reconciliation: when a posted bank transaction is
  // confirmed as this bill's payment, the row moves to the actual date/amount,
  // links the transaction here (one cash event, counted once), and keeps the
  // original planned date so un-confirm can revert.
  matchedPlaidTransactionId: integer("matched_plaid_transaction_id"),
  forecastedDate: date("forecasted_date", { mode: "string" }),
  // P6 part 2: derived "unplanned actual" row — posted bank spending/income
  // (start date → today) not matched to any planned bill/paycheck, bucketed
  // by day+category. Rebuilt idempotently by rollActualsForUser; not editable.
  isUnplanned: boolean("is_unplanned").notNull().default(false),
  // Transfer classification: true when this row is money moving between the
  // user's own accounts (savings/investment/account transfers) rather than
  // spending. It still steps the running balance (the cash genuinely left the
  // forecast pool) but must be excluded from expense/spending totals.
  isAssetMovement: boolean("is_asset_movement").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertForecastedTransactionSchema = createInsertSchema(forecastedTransactionsTable).omit({ id: true, userId: true, createdAt: true });
export type InsertForecastedTransaction = z.infer<typeof insertForecastedTransactionSchema>;
export type ForecastedTransaction = typeof forecastedTransactionsTable.$inferSelect;
