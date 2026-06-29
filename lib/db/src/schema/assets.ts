import { pgTable, serial, text, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const assetsTable = pgTable("assets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  assetName: text("asset_name").notNull(),
  assetType: text("asset_type").notNull(),
  institutionName: text("institution_name").notNull(),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
  isAsset: boolean("is_asset").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assetsTable).omit({ id: true, userId: true, createdAt: true });
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assetsTable.$inferSelect;
