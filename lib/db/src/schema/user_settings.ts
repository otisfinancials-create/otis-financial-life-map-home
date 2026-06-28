import { pgTable, serial, integer, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const userSettingsTable = pgTable("user_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(1),
  startingBalance: numeric("starting_balance", { precision: 12, scale: 2 }).notNull().default("0"),
  balanceAsOfDate: date("balance_as_of_date", { mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type UserSettings = typeof userSettingsTable.$inferSelect;

export const UpsertUserSettingsBody = z.object({
  startingBalance: z.number(),
  balanceAsOfDate: z.string(),
});
