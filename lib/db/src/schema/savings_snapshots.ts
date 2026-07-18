import { pgTable, serial, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// One row per user per calendar month ("YYYY-MM") recording the total balance
// of savings/investment/brokerage accounts. Upserted whenever the Savings &
// Investments summary is requested; powers the month-over-month change.
export const savingsSnapshotsTable = pgTable(
  "savings_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    month: text("month").notNull(), // YYYY-MM
    total: numeric("total", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("savings_snapshots_user_month_idx").on(t.userId, t.month)],
);

export type SavingsSnapshot = typeof savingsSnapshotsTable.$inferSelect;
