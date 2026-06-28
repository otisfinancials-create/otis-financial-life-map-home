import { pgTable, serial, integer, text, numeric, boolean, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const forecastedTransactionsTable = pgTable("forecasted_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(1),
  transactionDate: date("transaction_date", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  transactionType: text("transaction_type").notNull(),
  category: text("category").notNull(),
  sourceBillId: integer("source_bill_id"),
  sourcePayId: integer("source_pay_id"),
  isActual: boolean("is_actual").notNull().default(false),
  isCommitted: boolean("is_committed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertForecastedTransactionSchema = createInsertSchema(forecastedTransactionsTable).omit({ id: true, userId: true, createdAt: true });
export type InsertForecastedTransaction = z.infer<typeof insertForecastedTransactionSchema>;
export type ForecastedTransaction = typeof forecastedTransactionsTable.$inferSelect;
