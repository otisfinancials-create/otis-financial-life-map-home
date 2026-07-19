import { pgTable, serial, text, numeric, date, boolean, timestamp, integer, index, unique } from "drizzle-orm/pg-core";

/** Raw transactions synced from Plaid via /transactions/sync. */
export const plaidTransactionsTable = pgTable(
  "plaid_transactions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    plaidItemId: integer("plaid_item_id"),
    accountId: text("account_id").notNull(),
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    date: date("date", { mode: "string" }).notNull(),
    name: text("name"),
    merchantName: text("merchant_name"),
    category: text("category").array(),
    personalFinanceCategory: text("personal_finance_category"),
    personalFinanceCategoryDetailed: text("personal_finance_category_detailed"),
    paymentChannel: text("payment_channel"),
    pending: boolean("pending").notNull().default(false),
    transactionType: text("transaction_type"),
    currencyCode: text("currency_code").default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("plaid_transactions_plaid_transaction_id_unique").on(t.plaidTransactionId),
    index("idx_plaid_transactions_user_id").on(t.userId),
    index("idx_plaid_transactions_account_id").on(t.accountId),
    index("idx_plaid_transactions_date").on(t.date),
  ],
);

export type PlaidTransaction = typeof plaidTransactionsTable.$inferSelect;
