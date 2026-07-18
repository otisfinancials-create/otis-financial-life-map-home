import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const otisConversationsTable = pgTable("otis_conversations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OtisConversationMessage = typeof otisConversationsTable.$inferSelect;

export const otisResponseCacheTable = pgTable("otis_response_cache", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  cacheKey: text("cache_key").notNull(), // 'net_worth' | 'cash_flow'
  content: text("content").notNull(),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export type OtisResponseCacheRow = typeof otisResponseCacheTable.$inferSelect;
