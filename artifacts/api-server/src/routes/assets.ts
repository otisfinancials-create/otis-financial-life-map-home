import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, assetsTable } from "@workspace/db";
import {
  CreateAssetBody,
  UpdateAssetBody,
  GetAssetParams,
  UpdateAssetParams,
  DeleteAssetParams,
  ListAssetsResponse,
  CreateAssetResponse,
  GetAssetResponse,
  UpdateAssetResponse,
  GetAssetsSummaryResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/assets", async (req, res): Promise<void> => {
  req.log.info("Fetching assets");
  const assets = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.userId, req.userId))
    .orderBy(assetsTable.assetType, assetsTable.assetName);
  res.json(ListAssetsResponse.parse(assets.map(serialize)));
});

router.post("/assets", async (req, res): Promise<void> => {
  const parsed = CreateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [asset] = await db.insert(assetsTable).values({
    ...parsed.data,
    userId: req.userId,
    currentBalance: String(parsed.data.currentBalance),
  }).returning();
  res.status(201).json(CreateAssetResponse.parse(serialize(asset)));
});

router.get("/assets/summary", async (req, res): Promise<void> => {
  const assets = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.userId, req.userId));

  const totalAssets = assets
    .filter((a) => a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const totalLiabilities = assets
    .filter((a) => !a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  const byTypeMap: Record<string, { total: number; count: number }> = {};
  for (const asset of assets) {
    const type = asset.assetType;
    if (!byTypeMap[type]) byTypeMap[type] = { total: 0, count: 0 };
    const balance = parseFloat(String(asset.currentBalance));
    byTypeMap[type].total += asset.isAsset ? balance : -balance;
    byTypeMap[type].count += 1;
  }

  const byType = Object.entries(byTypeMap).map(([assetType, { total, count }]) => ({
    assetType,
    total,
    count,
  }));

  res.json(GetAssetsSummaryResponse.parse({ netWorth, totalAssets, totalLiabilities, byType }));
});

router.get("/assets/:id", async (req, res): Promise<void> => {
  const params = GetAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.userId)));
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.json(GetAssetResponse.parse(serialize(asset)));
});

router.patch("/assets/:id", async (req, res): Promise<void> => {
  const params = UpdateAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { currentBalance: rawBalance, ...restAssetData } = parsed.data;
  const [asset] = await db
    .update(assetsTable)
    .set({
      ...restAssetData,
      ...(rawBalance !== undefined && { currentBalance: String(rawBalance) }),
    })
    .where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.userId)))
    .returning();
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.json(UpdateAssetResponse.parse(serialize(asset)));
});

router.delete("/assets/:id", async (req, res): Promise<void> => {
  const params = DeleteAssetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [asset] = await db
    .delete(assetsTable)
    .where(and(eq(assetsTable.id, params.data.id), eq(assetsTable.userId, req.userId)))
    .returning();
  if (!asset) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.sendStatus(204);
});

function serialize(a: typeof assetsTable.$inferSelect) {
  return {
    ...a,
    currentBalance: parseFloat(String(a.currentBalance)),
    createdAt: a.createdAt.toISOString(),
  };
}

export default router;
