import { pgTable, serial, text, numeric, timestamp, date, integer, unique, index } from "drizzle-orm/pg-core";

/** P4: daily end-of-day balance snapshots captured from transactionsSync responses (no extra Plaid calls). */
export const balanceSnapshotsTable = pgTable(
  "balance_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    plaidItemId: integer("plaid_item_id").notNull(),
    accountId: text("account_id").notNull(), // Plaid account_id
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    current: numeric("current", { precision: 14, scale: 2 }),
    available: numeric("available", { precision: 14, scale: 2 }),
    creditLimit: numeric("credit_limit", { precision: 14, scale: 2 }), // balances.limit ("limit" is reserved)
    currencyCode: text("currency_code"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("balance_snapshots_account_date_unique").on(t.accountId, t.snapshotDate),
    index("idx_balance_snapshots_user_id").on(t.userId),
  ],
);

export type BalanceSnapshot = typeof balanceSnapshotsTable.$inferSelect;
