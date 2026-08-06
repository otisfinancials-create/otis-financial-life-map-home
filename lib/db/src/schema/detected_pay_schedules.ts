import { pgTable, serial, text, numeric, boolean, timestamp, date, integer, jsonb, unique } from "drizzle-orm/pg-core";

/** Recurring-income candidates detected from plaid_transactions. Review queue —
 *  mirrors detected_bills; never writes to pay_schedules without confirmation. */
export const detectedPaySchedulesTable = pgTable(
  "detected_pay_schedules",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    employerKey: text("employer_key").notNull(),
    displayName: text("display_name").notNull(),
    /** Proposed amount = most recent deposit (pay varies; range matters more). */
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    amountMin: numeric("amount_min", { precision: 12, scale: 2 }),
    amountMax: numeric("amount_max", { precision: 12, scale: 2 }),
    frequency: text("frequency").notNull(),
    /** True when biweekly vs semi-monthly could not be distinguished; the UI
     *  must present frequencyOptions instead of trusting `frequency`. */
    cadenceAmbiguous: boolean("cadence_ambiguous").notNull().default(false),
    frequencyOptions: jsonb("frequency_options"),
    occurrenceCount: integer("occurrence_count").notNull(),
    firstSeen: date("first_seen", { mode: "string" }),
    lastSeen: date("last_seen", { mode: "string" }),
    nextExpectedDate: date("next_expected_date", { mode: "string" }),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    status: text("status").notNull().default("pending"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    /** Set when the proposal duplicates an existing pay_schedules row. */
    duplicateOf: integer("duplicate_of"),
    sampleTxnIds: jsonb("sample_txn_ids"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("detected_pay_user_employer_freq_unique").on(t.userId, t.employerKey, t.frequency)],
);

export type DetectedPaySchedule = typeof detectedPaySchedulesTable.$inferSelect;
