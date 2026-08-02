import { pgTable, serial, text, numeric, boolean, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { accountsTable } from "./accounts";
import { z } from "zod/v4";

export const billsTable = pgTable("bills", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  billName: text("bill_name").notNull(),
  category: text("category").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  frequency: text("frequency").notNull(),
  // Interval in days for frequency='custom' (e.g. 548 for an 18-month service
  // cycle). NULL for every other frequency; required (>=1) when custom.
  customIntervalDays: integer("custom_interval_days"),
  dueDay: integer("due_day").notNull(),
  // Constrained set: 'credit-card' | 'debit-card' | 'bank-transfer' | 'check' | 'cash'
  // (enforced at the API layer; null = unknown/pending manual review).
  paymentMethod: text("payment_method"),
  // Which account pays this bill (nullable: cash/check bills may have none).
  paymentAccountId: integer("payment_account_id").references(() => accountsTable.id),
  // P5.5 — normalized merchant pattern charges are matched against (e.g.
  // "att mobility"), separate from the user-facing bill_name label. NULL =
  // not yet linked; the matcher falls back to display-name matching.
  matchMerchant: text("match_merchant"),
  isAutopay: boolean("is_autopay").notNull().default(false),
  amountType: text("amount_type").notNull().default("negative"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  companyUrl: text("company_url"),
  isVariable: boolean("is_variable").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  // Kind discriminator: 'regular' | 'goal_contribution'. category is
  // free-text/user-facing and cannot serve as a kind. Goal contribution
  // bills are excluded from bill detection and card cycle population.
  billKind: text("bill_kind").notNull().default("regular"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
