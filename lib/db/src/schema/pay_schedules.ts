import { pgTable, serial, integer, text, numeric, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paySchedulesTable = pgTable("pay_schedules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().default(1),
  employerName: text("employer_name").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  frequency: text("frequency").notNull(),
  nextPayDate: date("next_pay_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPayScheduleSchema = createInsertSchema(paySchedulesTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export type InsertPaySchedule = z.infer<typeof insertPayScheduleSchema>;
export type PaySchedule = typeof paySchedulesTable.$inferSelect;
