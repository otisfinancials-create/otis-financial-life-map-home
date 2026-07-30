import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { billsTable } from "./bills";
import { plaidTransactionsTable } from "./plaid_transactions";

/**
 * P6 — bank-paid bill reconciliation dismissals. When the user rejects a
 * suggested transaction↔bill match ("not a match"), record the pair so the
 * same transaction is never re-suggested for that bill.
 */
export const billMatchDismissalsTable = pgTable("bill_match_dismissals", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "cascade" }),
  plaidTransactionId: integer("plaid_transaction_id").notNull().references(() => plaidTransactionsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bill_match_dismissals_pair_unique").on(t.billId, t.plaidTransactionId),
]);

export type BillMatchDismissal = typeof billMatchDismissalsTable.$inferSelect;
