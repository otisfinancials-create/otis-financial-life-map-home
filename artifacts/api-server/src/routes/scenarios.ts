import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, scenariosTable } from "@workspace/db";
import {
  ListScenariosResponse,
  CreateScenarioBody,
  CreateScenarioResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serialize(row: typeof scenariosTable.$inferSelect) {
  return {
    id: row.id,
    scenarioName: row.scenarioName,
    scenarioType: row.scenarioType,
    inputParameters: row.inputParameters as Record<string, unknown>,
    resultsSummary: row.resultsSummary as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/scenarios", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(scenariosTable)
    .where(eq(scenariosTable.userId, req.userId))
    .orderBy(desc(scenariosTable.createdAt));
  res.json(ListScenariosResponse.parse(rows.map(serialize)));
});

router.post("/scenarios", async (req, res): Promise<void> => {
  const parsed = CreateScenarioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(scenariosTable)
    .values({
      userId: req.userId,
      scenarioName: parsed.data.scenarioName,
      scenarioType: parsed.data.scenarioType,
      inputParameters: parsed.data.inputParameters,
      resultsSummary: parsed.data.resultsSummary,
    })
    .returning();
  req.log.info({ scenarioId: row.id }, "Saved scenario");
  res.status(201).json(CreateScenarioResponse.parse(serialize(row)));
});

router.delete("/scenarios/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const deleted = await db
    .delete(scenariosTable)
    .where(and(eq(scenariosTable.id, id), eq(scenariosTable.userId, req.userId)))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
