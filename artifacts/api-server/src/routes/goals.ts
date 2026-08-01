import { Router, type IRouter } from "express";
import { eq, and, isNotNull } from "drizzle-orm";
import { db, goalsTable, billsTable, accountsTable, forecastedTransactionsTable, type Goal } from "@workspace/db";
import {
  CreateGoalBody,
  UpdateGoalBody,
  UpdateGoalParams,
  DeleteGoalParams,
  CommitGoalParams,
  UncommitGoalParams,
  ListGoalsResponse,
  CreateGoalResponse,
  UpdateGoalResponse,
  CommitGoalResponse,
  UncommitGoalResponse,
} from "@workspace/api-zod";
import { regenerateForecastForUser } from "./forecast";

const router: IRouter = Router();

/**
 * Goals — plan/commit lifecycle (Goals Design V1 + Decisions Addendum).
 *
 * The goal always lives in the goals table; the bill row is a consequence of
 * committing, not the goal itself. Draft goals have ZERO forecast impact.
 * v1 is real-transfer only: money must physically move from a forecast-pool
 * source account to a destination OUTSIDE the pool — otherwise both legs of
 * the transfer are internal, cancel to zero, and the goal is invisible.
 */

function toLocalIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole months from start to target (partial trailing month doesn't count). */
export function wholeMonthsBetween(startIso: string, targetIso: string): number {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ty, tm, td] = targetIso.split("-").map(Number);
  let months = (ty - sy) * 12 + (tm - sm);
  if (td < sd) months -= 1;
  return months;
}

/**
 * (target − alreadySaved) ÷ months, rounded UP to the nearest $5 so users
 * arrive slightly early rather than short. Cent-safe: an exact quotient
 * (e.g. $6,000 ÷ 12 = $500) must NOT round up a bracket to $505.
 */
export function computeMonthlyContribution(targetAmount: number, alreadySaved: number, months: number): number {
  const remainingCents = Math.round(targetAmount * 100) - Math.round(alreadySaved * 100);
  if (remainingCents <= 0) return 0;
  const rawCents = remainingCents / months;
  return Math.ceil(rawCents / 500 - 1e-9) * 5;
}

type GoalCore = {
  targetAmount: number;
  alreadySaved: number;
  startDate: string;
  targetDate: string;
  sourceAccountId: number;
  destinationAccountId: number;
  contributionDay: number;
};

/** Returns an error message or null. Also computes months/contribution. */
async function validateGoalCore(userId: string, g: GoalCore): Promise<{ error: string | null; monthlyContribution: number }> {
  if (g.targetDate <= g.startDate) {
    return { error: "Target date must be after the start date.", monthlyContribution: 0 };
  }
  const months = wholeMonthsBetween(g.startDate, g.targetDate);
  if (months < 1) {
    return { error: "Target date must be at least one whole month after the start date.", monthlyContribution: 0 };
  }
  if (g.contributionDay < 1 || g.contributionDay > 31) {
    return { error: "Contribution day must be between 1 and 31.", monthlyContribution: 0 };
  }
  const ids = [g.sourceAccountId, g.destinationAccountId];
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.userId, userId)));
  const source = accounts.find((a) => a.id === g.sourceAccountId);
  const destination = accounts.find((a) => a.id === g.destinationAccountId);
  void ids;
  if (!source) return { error: "Source account not found.", monthlyContribution: 0 };
  if (!destination) return { error: "Destination account not found.", monthlyContribution: 0 };
  if (!source.isForecastAccount) {
    return {
      error: "The source account must be one of your forecast (spending pool) accounts — the money has to leave the pool for the goal to have any visible effect.",
      monthlyContribution: 0,
    };
  }
  if (destination.isForecastAccount) {
    return {
      error:
        "The destination account is part of your forecast pool. Money moving between pool accounts is an internal transfer — both sides cancel out and the goal would have no visible effect on your forecast. Pick a savings or investment account outside your spending pool.",
      monthlyContribution: 0,
    };
  }
  if (g.sourceAccountId === g.destinationAccountId) {
    return { error: "Source and destination accounts must be different.", monthlyContribution: 0 };
  }
  return { error: null, monthlyContribution: computeMonthlyContribution(g.targetAmount, g.alreadySaved, months) };
}

function serializeGoal(goal: Goal) {
  return {
    ...goal,
    targetAmount: parseFloat(String(goal.targetAmount)),
    alreadySaved: parseFloat(String(goal.alreadySaved)),
    monthlyContribution: parseFloat(String(goal.monthlyContribution)),
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

router.get("/goals", async (req, res): Promise<void> => {
  const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, req.userId)).orderBy(goalsTable.createdAt);
  res.json(ListGoalsResponse.parse(goals.map(serializeGoal)));
});

router.post("/goals", async (req, res): Promise<void> => {
  const parsed = CreateGoalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const b = parsed.data;
  const core: GoalCore = {
    targetAmount: b.targetAmount,
    alreadySaved: b.alreadySaved ?? 0,
    startDate: b.startDate,
    targetDate: b.targetDate,
    sourceAccountId: b.sourceAccountId,
    destinationAccountId: b.destinationAccountId,
    contributionDay: b.contributionDay,
  };
  const { error, monthlyContribution } = await validateGoalCore(req.userId, core);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [goal] = await db
    .insert(goalsTable)
    .values({
      userId: req.userId,
      name: b.name,
      goalType: b.goalType,
      targetAmount: String(b.targetAmount),
      alreadySaved: String(core.alreadySaved),
      startDate: b.startDate,
      targetDate: b.targetDate,
      sourceAccountId: b.sourceAccountId,
      destinationAccountId: b.destinationAccountId,
      contributionDay: b.contributionDay,
      monthlyContribution: String(monthlyContribution),
      status: "draft",
    })
    .returning();
  req.log.info({ goalId: goal.id }, "Created goal (draft)");
  res.status(201).json(CreateGoalResponse.parse(serializeGoal(goal)));
});

router.patch("/goals/:id", async (req, res): Promise<void> => {
  const params = UpdateGoalParams.safeParse(req.params);
  const parsed = UpdateGoalBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: (params.success ? parsed : params).error?.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, params.data.id), eq(goalsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  const b = parsed.data;
  const core: GoalCore = {
    targetAmount: b.targetAmount ?? parseFloat(String(existing.targetAmount)),
    alreadySaved: b.alreadySaved ?? parseFloat(String(existing.alreadySaved)),
    startDate: b.startDate ?? existing.startDate,
    targetDate: b.targetDate ?? existing.targetDate,
    sourceAccountId: b.sourceAccountId ?? existing.sourceAccountId,
    destinationAccountId: b.destinationAccountId ?? existing.destinationAccountId,
    contributionDay: b.contributionDay ?? existing.contributionDay,
  };
  const { error, monthlyContribution } = await validateGoalCore(req.userId, core);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  // Goal + linked-bill updates are atomic: a committed goal must never end
  // up with a bill whose terms drifted from the goal's.
  const goal = await db.transaction(async (tx) => {
    const [g] = await tx
      .update(goalsTable)
      .set({
        name: b.name ?? existing.name,
        goalType: b.goalType ?? existing.goalType,
        targetAmount: String(core.targetAmount),
        alreadySaved: String(core.alreadySaved),
        startDate: core.startDate,
        targetDate: core.targetDate,
        sourceAccountId: core.sourceAccountId,
        destinationAccountId: core.destinationAccountId,
        contributionDay: core.contributionDay,
        monthlyContribution: String(monthlyContribution),
        isActive: b.isActive ?? existing.isActive,
      })
      .where(eq(goalsTable.id, existing.id))
      .returning();

    // EDIT AFTER COMMIT — recompute forward only. Update the bill's terms;
    // forecast regeneration preserves paid/reconciled rows, so history is
    // never rewritten (only future planned occurrences move).
    if (existing.status === "committed" && existing.billId != null) {
      const updatedBills = await tx
        .update(billsTable)
        .set({
          billName: g.name,
          amount: String(monthlyContribution),
          dueDay: g.contributionDay,
          paymentAccountId: g.sourceAccountId,
          startDate: g.startDate,
          endDate: g.targetDate,
        })
        .where(and(eq(billsTable.id, existing.billId), eq(billsTable.userId, req.userId)))
        .returning({ id: billsTable.id });
      if (updatedBills.length === 0) {
        throw new Error("Linked contribution bill not found — goal/bill linkage is inconsistent");
      }
    }
    return g;
  });
  if (existing.status === "committed" && existing.billId != null) {
    await regenerateForecastForUser(req.userId);
  }
  res.json(UpdateGoalResponse.parse(serializeGoal(goal)));
});

router.delete("/goals/:id", async (req, res): Promise<void> => {
  const params = DeleteGoalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, params.data.id), eq(goalsTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  if (existing.status === "committed") {
    res.status(400).json({ error: "Uncommit the goal before deleting it." });
    return;
  }
  await db.delete(goalsTable).where(eq(goalsTable.id, existing.id));
  res.status(204).send();
});

/**
 * COMMIT — the goal's monthly contribution becomes a bill row
 * (billKind = 'goal_contribution') and rides the existing bill → forecast
 * machinery. Never card-paid: a savings transfer is a bank transfer.
 */
router.post("/goals/:id/commit", async (req, res): Promise<void> => {
  const params = CommitGoalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [goal] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, params.data.id), eq(goalsTable.userId, req.userId)));
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  if (goal.status === "committed") {
    res.status(400).json({ error: "Goal is already committed." });
    return;
  }
  // Re-validate at commit time — pool membership may have changed since draft.
  const core: GoalCore = {
    targetAmount: parseFloat(String(goal.targetAmount)),
    alreadySaved: parseFloat(String(goal.alreadySaved)),
    startDate: goal.startDate,
    targetDate: goal.targetDate,
    sourceAccountId: goal.sourceAccountId,
    destinationAccountId: goal.destinationAccountId,
    contributionDay: goal.contributionDay,
  };
  const { error, monthlyContribution } = await validateGoalCore(req.userId, core);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  // Atomic + idempotent: claim the goal with a conditional update first so
  // two concurrent commits can't both create a bill, then create the bill
  // and link it — all in one transaction.
  const updated = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(goalsTable)
      .set({ status: "committed", monthlyContribution: String(monthlyContribution) })
      .where(and(eq(goalsTable.id, goal.id), eq(goalsTable.userId, req.userId), eq(goalsTable.status, goal.status)))
      .returning();
    if (claimed.length === 0) return null; // someone else won the race
    const [bill] = await tx
      .insert(billsTable)
      .values({
        userId: req.userId,
        billName: goal.name,
        category: "Other",
        amount: String(monthlyContribution),
        frequency: "monthly",
        dueDay: goal.contributionDay,
        paymentMethod: "bank-transfer",
        paymentAccountId: goal.sourceAccountId,
        matchMerchant: null,
        isVariable: false,
        isActive: true,
        billKind: "goal_contribution",
        startDate: goal.startDate,
        endDate: goal.targetDate,
        amountType: "negative",
      })
      .returning();
    const [linked] = await tx.update(goalsTable).set({ billId: bill.id }).where(eq(goalsTable.id, goal.id)).returning();
    return { linked, billId: bill.id };
  });
  if (!updated) {
    res.status(409).json({ error: "Goal was modified concurrently — refresh and try again." });
    return;
  }

  await regenerateForecastForUser(req.userId);
  req.log.info({ goalId: goal.id, billId: updated.billId }, "Committed goal");
  res.json(CommitGoalResponse.parse(serializeGoal(updated.linked)));
});

/**
 * UNCOMMIT —
 *  - no reconciled forecast rows: delete the bill (and its planned rows).
 *  - any reconciled rows: end-date the bill as of today + deactivate. Those
 *    transfers really happened; hard-deleting would orphan the history.
 *    Deliberately NOT the bills DELETE path — that one hard-deletes and
 *    detaches card cycle allocations to a catch-all envelope (lossy).
 */
router.post("/goals/:id/uncommit", async (req, res): Promise<void> => {
  const params = UncommitGoalParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [goal] = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.id, params.data.id), eq(goalsTable.userId, req.userId)));
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  if (goal.status !== "committed" || goal.billId == null) {
    res.status(400).json({ error: "Goal is not committed." });
    return;
  }

  const reconciled = await db
    .select({ id: forecastedTransactionsTable.id })
    .from(forecastedTransactionsTable)
    .where(
      and(
        eq(forecastedTransactionsTable.userId, req.userId),
        eq(forecastedTransactionsTable.sourceBillId, goal.billId),
        eq(forecastedTransactionsTable.isActual, true),
        isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      ),
    )
    .limit(1);

  if (reconciled.length === 0) {
    // Clean removal: planned forecast rows first, then the bill.
    await db.transaction(async (tx) => {
      await tx
        .delete(forecastedTransactionsTable)
        .where(and(eq(forecastedTransactionsTable.userId, req.userId), eq(forecastedTransactionsTable.sourceBillId, goal.billId!)));
      await tx.update(goalsTable).set({ billId: null, status: "draft" }).where(eq(goalsTable.id, goal.id));
      await tx.delete(billsTable).where(and(eq(billsTable.id, goal.billId!), eq(billsTable.userId, req.userId)));
    });
  } else {
    // History exists: end-date + deactivate, keep the bill row and its
    // reconciled forecast rows intact. Future planned rows are cleaned up
    // by regeneration (bill inactive => no occurrences emitted).
    await db.transaction(async (tx) => {
      await tx
        .update(billsTable)
        .set({ endDate: toLocalIsoDate(new Date()), isActive: false })
        .where(and(eq(billsTable.id, goal.billId!), eq(billsTable.userId, req.userId)));
      await tx.update(goalsTable).set({ billId: null, status: "draft" }).where(eq(goalsTable.id, goal.id));
    });
  }

  await regenerateForecastForUser(req.userId);
  const [updated] = await db.select().from(goalsTable).where(eq(goalsTable.id, goal.id));
  req.log.info({ goalId: goal.id, billId: goal.billId, hadReconciled: reconciled.length > 0 }, "Uncommitted goal");
  res.json(UncommitGoalResponse.parse(serializeGoal(updated)));
});

export default router;
