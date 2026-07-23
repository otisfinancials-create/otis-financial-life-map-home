import { pgTable, serial, text, numeric, boolean, timestamp, date, integer, jsonb, unique } from "drizzle-orm/pg-core";

/** Recurring-bill candidates detected from plaid_transactions. Review queue — never writes to bills directly. */
export const detectedBillsTable = pgTable(
  "detected_bills",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    merchantKey: text("merchant_key").notNull(),
    displayName: text("display_name").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    amountMin: numeric("amount_min", { precision: 12, scale: 2 }),
    amountMax: numeric("amount_max", { precision: 12, scale: 2 }),
    isVariable: boolean("is_variable").notNull().default(false),
    frequency: text("frequency").notNull(),
    occurrenceCount: integer("occurrence_count").notNull(),
    firstSeen: date("first_seen", { mode: "string" }),
    lastSeen: date("last_seen", { mode: "string" }),
    nextExpectedDate: date("next_expected_date", { mode: "string" }),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    status: text("status").notNull().default("pending"),
    duplicateOf: integer("duplicate_of"),
    sampleTxnIds: jsonb("sample_txn_ids"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("detected_bills_user_merchant_freq_unique").on(t.userId, t.merchantKey, t.frequency)],
);

export type DetectedBill = typeof detectedBillsTable.$inferSelect;
