import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";

const router: IRouter = Router();

function serialize(s: typeof userSettingsTable.$inferSelect) {
  return {
    id: s.id,
    startingBalance: parseFloat(String(s.startingBalance)),
    balanceAsOfDate: s.balanceAsOfDate,
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/user-settings", async (req, res): Promise<void> => {
  const [settings] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, 1))
    .limit(1);

  if (!settings) {
    res.json({ id: 0, startingBalance: 0, balanceAsOfDate: new Date().toISOString().split("T")[0], updatedAt: new Date().toISOString() });
    return;
  }
  res.json(serialize(settings));
});

router.post("/user-settings", async (req, res): Promise<void> => {
  const { startingBalance, balanceAsOfDate } = req.body as { startingBalance: number; balanceAsOfDate: string };
  if (typeof startingBalance !== "number" || !balanceAsOfDate) {
    res.status(400).json({ error: "startingBalance and balanceAsOfDate are required" });
    return;
  }

  const existing = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, 1))
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await db
      .update(userSettingsTable)
      .set({ startingBalance: String(startingBalance), balanceAsOfDate, updatedAt: new Date() })
      .where(eq(userSettingsTable.userId, 1))
      .returning();
    res.json(serialize(updated));
  } else {
    const [created] = await db
      .insert(userSettingsTable)
      .values({ userId: 1, startingBalance: String(startingBalance), balanceAsOfDate })
      .returning();
    res.json(serialize(created));
  }
});

export default router;
