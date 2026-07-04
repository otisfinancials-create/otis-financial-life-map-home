import { pgTable, serial, text, numeric, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const loansTable = pgTable("loans", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  loanName: text("loan_name").notNull(),
  lenderName: text("lender_name").notNull(),
  loanType: text("loan_type").notNull(),
  originalAmount: numeric("original_amount", { precision: 15, scale: 2 }).notNull(),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
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
