import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { billsTable } from "./bills";
import { paySchedulesTable } from "./pay_schedules";
import { plaidTransactionsTable } from "./plaid_transactions";

/**
 * P6/P7 — reconciliation dismissals. When the user rejects a suggested
 * transaction↔bill (or transaction↔paycheck) match ("not a match"), record
 * the pair so the same transaction is never re-suggested for that source.
 * Exactly one of billId / payScheduleId is set.
 */
export const billMatchDismissalsTable = pgTable("bill_match_dismissals", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  billId: integer("bill_id").references(() => billsTable.id, { onDelete: "cascade" }),
  payScheduleId: integer("pay_schedule_id").references(() => paySchedulesTable.id, { onDelete: "cascade" }),
  plaidTransactionId: integer("plaid_transaction_id").notNull().references(() => plaidTransactionsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("bill_match_dismissals_pair_unique").on(t.billId, t.plaidTransactionId),
  unique("pay_match_dismissals_pair_unique").on(t.payScheduleId, t.plaidTransactionId),
]);

export type BillMatchDismissal = typeof billMatchDismissalsTable.$inferSelect;
