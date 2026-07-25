import { pgTable, serial, text, numeric, integer, date, timestamp, unique } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";
import { billsTable } from "./bills";

/**
 * P5 Stage 1 — credit-card billing cycles. One row per card per statement
 * period. planned_total / accumulated_total are rolled up in later stages.
 */
export const cardCyclesTable = pgTable("card_cycles", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  accountId: integer("account_id").notNull().references(() => accountsTable.id),
  cycleStart: date("cycle_start", { mode: "string" }).notNull(),
  cycleEnd: date("cycle_end", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  plannedTotal: numeric("planned_total", { precision: 15, scale: 2 }).default("0"),
  accumulatedTotal: numeric("accumulated_total", { precision: 15, scale: 2 }).default("0"),
  status: text("status").default("open"), // 'open' | 'closed' | 'paid'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("card_cycles_account_start_unique").on(t.accountId, t.cycleStart)]);

/** Spending envelopes within a card cycle (CRUD in Stage 2). */
export const envelopesTable = pgTable("envelopes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  cardCycleId: integer("card_cycle_id").notNull().references(() => cardCyclesTable.id),
  name: text("name").notNull(),
  category: text("category"),
  plannedAmount: numeric("planned_amount", { precision: 15, scale: 2 }).default("0"),
  spentAmount: numeric("spent_amount", { precision: 15, scale: 2 }).default("0"),
  cadence: text("cadence"), // 'weekly' | 'one-time'
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Bills expected within a card cycle (populated in Stage 3). */
export const cardCycleBillsTable = pgTable("card_cycle_bills", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  cardCycleId: integer("card_cycle_id").notNull().references(() => cardCyclesTable.id),
  billId: integer("bill_id").notNull().references(() => billsTable.id),
  expectedAmount: numeric("expected_amount", { precision: 15, scale: 2 }),
  actualAmount: numeric("actual_amount", { precision: 15, scale: 2 }),
  status: text("status").default("pending"), // 'pending' | 'hit' | 'missed'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Transaction → envelope / cycle-bill allocations (engine in Stage 3). */
export const envelopeAllocationsTable = pgTable("envelope_allocations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  plaidTransactionId: text("plaid_transaction_id"), // nullable: manual cards have no plaid txn
  envelopeId: integer("envelope_id").references(() => envelopesTable.id),
  cardCycleBillId: integer("card_cycle_bill_id").references(() => cardCycleBillsTable.id),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  source: text("source").notNull(), // 'auto' | 'manual'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CardCycle = typeof cardCyclesTable.$inferSelect;
export type Envelope = typeof envelopesTable.$inferSelect;
export type CardCycleBill = typeof cardCycleBillsTable.$inferSelect;
export type EnvelopeAllocation = typeof envelopeAllocationsTable.$inferSelect;
