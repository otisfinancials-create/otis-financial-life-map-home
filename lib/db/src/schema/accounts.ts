import { pgTable, serial, text, numeric, boolean, timestamp, integer } from "drizzle-orm/pg-core";
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
  accountNumberLast4: text("account_number_last4"),
  ccCycleStartDate: integer("cc_cycle_start_date"),
  ccCycleEndDate: integer("cc_cycle_end_date"),
  ccPaymentDueDate: integer("cc_payment_due_date"),
  notes: text("notes"),
  plaidAccountId: text("plaid_account_id"),
  plaidItemId: integer("plaid_item_id"),
  availableBalance: numeric("available_balance", { precision: 15, scale: 2 }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true, plaidAccountId: true, plaidItemId: true, availableBalance: true, lastSyncedAt: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
