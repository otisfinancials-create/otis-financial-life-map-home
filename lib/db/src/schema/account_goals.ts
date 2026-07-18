import { pgTable, serial, text, integer, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

export const accountGoalsTable = pgTable(
  "account_goals",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    goalAmount: numeric("goal_amount", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("account_goals_user_account_idx").on(t.userId, t.accountId)],
);

export type AccountGoal = typeof accountGoalsTable.$inferSelect;
