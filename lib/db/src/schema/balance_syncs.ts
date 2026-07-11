import { pgTable, serial, text, numeric, timestamp, date } from "drizzle-orm/pg-core";

export const balanceSyncsTable = pgTable("balance_syncs", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  syncDate: date("sync_date", { mode: "string" }).notNull(),
  forecastedBalance: numeric("forecasted_balance", { precision: 12, scale: 2 }).notNull(),
  actualBalance: numeric("actual_balance", { precision: 12, scale: 2 }).notNull(),
  variance: numeric("variance", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BalanceSync = typeof balanceSyncsTable.$inferSelect;
