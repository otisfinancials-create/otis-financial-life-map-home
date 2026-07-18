import { pgTable, serial, text, numeric, boolean, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const lifeEventsTable = pgTable("life_events", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  eventName: text("event_name").notNull(),
  category: text("category").notNull(),
  customCategory: text("custom_category"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  timingType: text("timing_type").notNull(),
  eventDate: date("event_date", { mode: "string" }),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  frequency: text("frequency"),
  customIntervalDays: integer("custom_interval_days"),
  priority: text("priority").notNull().default("planning_to"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertLifeEventSchema = createInsertSchema(lifeEventsTable).omit({ id: true, userId: true, createdAt: true, updatedAt: true });
export type InsertLifeEvent = z.infer<typeof insertLifeEventSchema>;
export type LifeEvent = typeof lifeEventsTable.$inferSelect;
