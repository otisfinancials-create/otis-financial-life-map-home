import { pgTable, serial, text, numeric, boolean, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountName: text("account_name").notNull(),
  accountType: text("account_type").notNull(),
  institutionName: text("institution_name").notNull(),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
  monthlyContribution: numeric("monthly_contribution", { precision: 12, scale: 2 }).notNull().default("0"),
  savingsGoal: numeric("savings_goal", { precision: 15, scale: 2 }),
  retirementSubtype: text("retirement_subtype"),
  isAsset: boolean("is_asset").notNull().default(true),
  // Forecast account boundary: only accounts the user explicitly opted in
  // contribute to the forecast's running balance / actuals ingestion.
  // Credit cards are NEVER forecast accounts (enforced in routes).
  isForecastAccount: boolean("is_forecast_account").notNull().default(false),
  accountNumberLast4: text("account_number_last4"),
  ccCycleStartDate: integer("cc_cycle_start_date"),
  ccCycleEndDate: integer("cc_cycle_end_date"),
  ccPaymentDueDate: integer("cc_payment_due_date"),
  // P5 card-cycle config: day of month the statement closes / payment is due (1-31).
  statementDay: integer("statement_day"),
  dueDay: integer("due_day"),
  notes: text("notes"),
  plaidAccountId: text("plaid_account_id"),
  plaidItemId: integer("plaid_item_id"),
  availableBalance: numeric("available_balance", { precision: 15, scale: 2 }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One local row per linked Plaid account per user: makes account
  // reconciliation (link + update-mode refresh) race-safe. NULLs (manual
  // accounts) are exempt per Postgres unique semantics.
  unique("accounts_user_plaid_account_unique").on(t.userId, t.plaidAccountId),
]);

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true, plaidAccountId: true, plaidItemId: true, availableBalance: true, lastSyncedAt: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
