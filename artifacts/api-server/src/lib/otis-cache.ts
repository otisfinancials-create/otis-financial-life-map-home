import { and, eq, inArray } from "drizzle-orm";
import { db, otisResponseCacheTable } from "@workspace/db";

export type OtisCacheKey = "net_worth" | "cash_flow";

export async function getOtisCachedResponse(userId: string, cacheKey: OtisCacheKey) {
  const rows = await db
    .select()
    .from(otisResponseCacheTable)
    .where(and(eq(otisResponseCacheTable.userId, userId), eq(otisResponseCacheTable.cacheKey, cacheKey)))
    .limit(1);
  return rows[0] ?? null;
}

export async function setOtisCachedResponse(userId: string, cacheKey: OtisCacheKey, content: string) {
  await db
    .delete(otisResponseCacheTable)
    .where(and(eq(otisResponseCacheTable.userId, userId), eq(otisResponseCacheTable.cacheKey, cacheKey)));
  await db.insert(otisResponseCacheTable).values({ userId, cacheKey, content });
}

/** Invalidate cached Otis answers when underlying data changes. */
export async function invalidateOtisCache(userId: string, keys: OtisCacheKey[]) {
  if (keys.length === 0) return;
  await db
    .delete(otisResponseCacheTable)
    .where(and(eq(otisResponseCacheTable.userId, userId), inArray(otisResponseCacheTable.cacheKey, keys)));
}
