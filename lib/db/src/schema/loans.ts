import { pgTable, serial, text, numeric, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accountsTable } from "./accounts";

export const loansTable = pgTable("loans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  loanName: text("loan_name").notNull(),
  lenderName: text("lender_name").notNull(),
  loanType: text("loan_type").notNull(),
  // Explicit link to a Connected Account tracking the same debt. When set,
  // the ACCOUNT owns the balance (liabilities counts the account, skips the
  // loan) and the loan contributes only the amortization schedule.
  accountId: integer("account_id").references(() => accountsTable.id),
  originalAmount: numeric("original_amount", { precision: 15, scale: 2 }).notNull(),
  // Nullable ONLY when accountId is set — an ignored-but-present number
  // would eventually be read by something. Enforced in the API layer.
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }),
  interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull(),
  monthlyPayment: numeric("monthly_payment", { precision: 15, scale: 2 }).notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  termMonths: integer("term_months").notNull(),
  nextPaymentDate: date("next_payment_date", { mode: "string" }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLoanSchema = createInsertSchema(loansTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export type InsertLoan = z.infer<typeof insertLoanSchema>;
export type Loan = typeof loansTable.$inferSelect;
