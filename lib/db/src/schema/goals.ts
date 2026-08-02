import { pgTable, serial, text, numeric, boolean, timestamp, date, integer } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";
import { billsTable } from "./bills";

/**
 * Goals — the goal always lives here; a bill row is a consequence of
 * committing, not the goal itself (Goals Design V1 + Decisions Addendum §3).
 *
 * v1 supports real-transfer goals only: money must physically move from a
 * forecast-pool checking account (source) to an account OUTSIDE the forecast
 * pool (destination). If the destination were inside the pool the transfer
 * would be internal, both legs would cancel, and the goal would be invisible
 * (addendum §1).
 */
export const goalsTable = pgTable("goals", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  // 'spend' | 'accumulation' — v1 delivers accumulation end-to-end.
  goalType: text("goal_type").notNull(),
  // NULL = open-ended accumulation goal: no target to measure against, the
  // user supplies monthlyContribution directly and it runs until stopped.
  targetAmount: numeric("target_amount", { precision: 12, scale: 2 }),
  // Seeds progress only. Never creates a forecast row: that money left
  // checking in the past and is already reflected in the anchored balance.
  alreadySaved: numeric("already_saved", { precision: 12, scale: 2 }).notNull().default("0"),
  startDate: date("start_date", { mode: "string" }).notNull(),
  // NULL for open-ended goals — the contribution bill gets NO end date.
  targetDate: date("target_date", { mode: "string" }),
  // Checking account the money leaves from (must be in the forecast pool).
  sourceAccountId: integer("source_account_id")
    .notNull()
    .references(() => accountsTable.id),
  // Where the money goes (must be OUTSIDE the forecast pool).
  destinationAccountId: integer("destination_account_id")
    .notNull()
    .references(() => accountsTable.id),
  contributionDay: integer("contribution_day").notNull(),
  // Computed and stored: (target − alreadySaved) ÷ months, rounded UP to $5.
  monthlyContribution: numeric("monthly_contribution", { precision: 12, scale: 2 }).notNull(),
  // 'draft' | 'committed' | 'completed' | 'cancelled'
  status: text("status").notNull().default("draft"),
  // ACTUAL bucket (Goals part 2 §1b): alreadySaved + reconciled contributions
  // − withdrawals. Stored so the invariant (stored == derived) is checkable;
  // nothing consumes it yet — it is the future progress-bar number and the
  // reconciliation target. Kept in lockstep whenever alreadySaved changes.
  actualBucket: numeric("actual_bucket", { precision: 12, scale: 2 }).notNull().default("0"),
  // Set on commit; the contribution bill this goal rides on.
  billId: integer("bill_id").references(() => billsTable.id),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Goal = typeof goalsTable.$inferSelect;
export type InsertGoal = typeof goalsTable.$inferInsert;
