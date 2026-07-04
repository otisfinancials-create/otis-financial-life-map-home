import { pgTable, serial, text, numeric, boolean, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  assetName: text("asset_name").notNull(),
  assetType: text("asset_type").notNull(),
  institutionName: text("institution_name").notNull().default(""),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
  isAsset: boolean("is_asset").notNull().default(true),
  purchasePrice: numeric("purchase_price", { precision: 15, scale: 2 }),
  purchaseDate: date("purchase_date", { mode: "string" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assetsTable).omit({ id: true, userId: true, createdAt: true });
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
