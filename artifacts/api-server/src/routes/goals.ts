import { Router, type IRouter } from "express";
import { eq, and, or, isNull, isNotNull, inArray, gte, lt, sql } from "drizzle-orm";
import { db, goalsTable, billsTable, accountsTable, forecastedTransactionsTable, type Goal } from "@workspace/db";
import {
  RemoveGoalPurchaseParams,
  RemoveGoalPurchaseResponse,
} from "@workspace/api-zod";
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
  GetGoalSurplusResponse,
} from "@workspace/api-zod";
import { regenerateForecastForUser, generateBillOccurrences } from "./forecast";

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

/**
 * Number of contribution occurrences the forecast will ACTUALLY emit for a
 * monthly contribution bill (startDate, endDate=targetDate, dueDay). Derived
 * from generateBillOccurrences — the exact generator the forecast uses — so
 * the divisor can never drift from the emitted schedule again (the old
 * whole-months computation was off by one: a 09-01→12-31 day-1 window emits
 * FOUR rows, not three).
 */
export function contributionOccurrenceCount(startIso: string, targetIso: string, day: number): number {
  return generateBillOccurrences(
    { frequency: "monthly", dueDay: day, startDate: startIso, endDate: targetIso },
    startIso,
    targetIso,
  ).length;
}

/**
 * (target − alreadySaved) ÷ contribution count, rounded UP to the nearest $5
 * so users arrive slightly early rather than short. Cent-safe: an exact
 * quotient (e.g. $6,000 ÷ 12 = $500) must NOT round up a bracket to $505.
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
  if (g.contributionDay < 1 || g.contributionDay > 31) {
    return { error: "Contribution day must be between 1 and 31.", monthlyContribution: 0 };
  }
  const months = contributionOccurrenceCount(g.startDate, g.targetDate, g.contributionDay);
  if (months < 1) {
    return { error: "No contribution dates fall between the start date and the target date for that contribution day.", monthlyContribution: 0 };
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

/** Monthly occurrence dates on contributionDay in [startIso, endIso] — same generator the forecast uses. */
function scheduledContributionDates(startIso: string, endIso: string, day: number): string[] {
  return generateBillOccurrences(
    { frequency: "monthly", dueDay: day, startDate: startIso, endDate: endIso },
    startIso,
    endIso,
  );
}

type BucketInfo = {
  projectedBucketAtSpendDate: number | null;
  shortfall: number | null;
  bucketInvariant: { stored: number; derived: number; ok: boolean };
};

/**
 * Part 1 bucket numbers.
 *  1a PROJECTED bucket at the spend date = alreadySaved + scheduled
 *     contributions ≤ that date (future contributions haven't posted — the
 *     purchase nets against the SCHEDULE).
 *  1b ACTUAL bucket = alreadySaved + reconciled contributions − withdrawals.
 *     Stored on the goal; the invariant (stored == derived) is exposed on
 *     every read so a drift is visible, not a console warning.
 */
async function computeBuckets(userId: string, goal: Goal): Promise<BucketInfo> {
  const alreadySaved = parseFloat(String(goal.alreadySaved));
  const target = parseFloat(String(goal.targetAmount));

  // Reconciled contributions on the goal's bill (none exist yet in this
  // phase — reconciliation is the next task — but derive, don't assume).
  let reconciledSum = 0;
  if (goal.billId != null) {
    const rows = await db
      .select({ amount: forecastedTransactionsTable.amount })
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.userId, userId),
        eq(forecastedTransactionsTable.sourceBillId, goal.billId),
        eq(forecastedTransactionsTable.isActual, true),
        isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      ));
    reconciledSum = rows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);
  }
  // Withdrawals: actualized funding legs (money pulled back out of the bucket).
  const withdrawalRows = await db
    .select({ amount: forecastedTransactionsTable.amount })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.sourceGoalId, goal.id),
      eq(forecastedTransactionsTable.transactionType, "income"),
      eq(forecastedTransactionsTable.isActual, true),
    ));
  const withdrawals = withdrawalRows.reduce((s, r) => s + parseFloat(String(r.amount)), 0);

  const derived = Math.round((alreadySaved + reconciledSum - withdrawals) * 100) / 100;
  const stored = parseFloat(String(goal.actualBucket));
  const invariant = { stored, derived, ok: Math.abs(stored - derived) < 0.005 };

  if (goal.goalType !== "spend") {
    return { projectedBucketAtSpendDate: null, shortfall: null, bucketInvariant: invariant };
  }
  // Scheduled contributions ≤ spend date. Use the committed bill's terms when
  // one exists; otherwise the draft goal's own schedule.
  let contribution = parseFloat(String(goal.monthlyContribution));
  let schedStart = goal.startDate;
  let schedEnd = goal.targetDate;
  let schedDay = goal.contributionDay;
  if (goal.billId != null) {
    const [bill] = await db.select().from(billsTable).where(and(eq(billsTable.id, goal.billId), eq(billsTable.userId, userId)));
    if (bill) {
      contribution = parseFloat(String(bill.amount));
      schedStart = bill.startDate ?? schedStart;
      schedEnd = bill.endDate && bill.endDate < goal.targetDate ? bill.endDate : goal.targetDate;
      schedDay = bill.dueDay;
    }
  }
  const count = scheduledContributionDates(schedStart, schedEnd, schedDay).filter((d) => d <= goal.targetDate).length;
  const projected = Math.round((alreadySaved + contribution * count) * 100) / 100;
  const shortfall = Math.max(0, Math.round((target - Math.min(projected, target)) * 100) / 100);
  return { projectedBucketAtSpendDate: projected, shortfall, bucketInvariant: invariant };
}

function serializeGoal(goal: Goal, buckets?: BucketInfo) {
  return {
    ...goal,
    targetAmount: parseFloat(String(goal.targetAmount)),
    alreadySaved: parseFloat(String(goal.alreadySaved)),
    monthlyContribution: parseFloat(String(goal.monthlyContribution)),
    actualBucket: parseFloat(String(goal.actualBucket)),
    ...(buckets ?? {}),
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

async function serializeGoalFull(userId: string, goal: Goal) {
  return serializeGoal(goal, await computeBuckets(userId, goal));
}

/**
 * Surplus — design §4/§5. ONE computation, TWO presentations:
 *   availableMonthly — mean monthly net AFTER committed goal contributions
 *     ("can I afford one more goal?"). Committing a goal reduces it — that
 *     money is committed and must not look available.
 *   grossMonthly — contributions added back ("do my goals fit my income?").
 *
 * Derivation (read-only, straight from the ledger the forecast emits):
 *   Σ signedF over forecasted_transactions in each of the next 12 full
 *   months, parent-card-row convention (cc_account_id IS NULL OR is_cc_parent)
 *   so bills that flow into a card payment row are never double-counted,
 *   status ≠ 'removed', asset movements excluded (they are allocations of
 *   surplus, not consumption — same circularity argument as goal rows), and
 *   goal purchase/funding legs excluded (lump events, not monthly capacity).
 *
 * leakageMonthly is a DIAGNOSTIC — trailing-6-complete-month average of
 * checking outflows that match no bill, card payment, or transfer. It is
 * reported alongside surplus, never subtracted: envelopes already cover
 * discretionary spend, subtracting on top would double-count.
 */
router.get("/goals/surplus", async (req, res): Promise<void> => {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const endDate = new Date(now.getFullYear(), now.getMonth() + 13, 1);
  const windowStart = toLocalIsoDate(startDate);
  const windowEnd = toLocalIsoDate(endDate);

  const goalBills = await db
    .select({ id: billsTable.id })
    .from(billsTable)
    .where(and(eq(billsTable.userId, req.userId), eq(billsTable.billKind, "goal_contribution")));
  const goalBillIds = new Set(goalBills.map((b) => b.id));

  const committed = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.userId, req.userId), eq(goalsTable.status, "committed")));

  const rows = await db
    .select({
      date: forecastedTransactionsTable.transactionDate,
      amount: forecastedTransactionsTable.amount,
      type: forecastedTransactionsTable.transactionType,
      sourceBillId: forecastedTransactionsTable.sourceBillId,
    })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, req.userId),
      gte(forecastedTransactionsTable.transactionDate, windowStart),
      lt(forecastedTransactionsTable.transactionDate, windowEnd),
      or(isNull(forecastedTransactionsTable.ccAccountId), eq(forecastedTransactionsTable.isCcParent, true)),
      sql`${forecastedTransactionsTable.status} IS DISTINCT FROM 'removed'`,
      eq(forecastedTransactionsTable.isAssetMovement, false),
      isNull(forecastedTransactionsTable.sourceGoalId),
    ));

  const monthKeys: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    monthKeys.push(toLocalIsoDate(d).slice(0, 7));
  }
  const available = new Map<string, number>(monthKeys.map((k) => [k, 0]));
  const contribAddback = new Map<string, number>(monthKeys.map((k) => [k, 0]));
  for (const r of rows) {
    const key = String(r.date).slice(0, 7);
    if (!available.has(key)) continue;
    const amt = parseFloat(String(r.amount));
    const signed = r.type === "income" ? amt : -amt;
    available.set(key, available.get(key)! + signed);
    if (r.sourceBillId != null && goalBillIds.has(r.sourceBillId)) {
      // Contribution rows are expenses; adding the amount back yields gross.
      contribAddback.set(key, contribAddback.get(key)! + amt);
    }
  }
  // The forecast horizon may end before the 12-month window does; a month
  // with no ledger rows at all is "beyond the forecast", not "$0 surplus" —
  // drop trailing empty months so they can't dilute the average.
  const monthsWithRows = new Set(rows.map((r) => String(r.date).slice(0, 7)));
  while (monthKeys.length > 1 && !monthsWithRows.has(monthKeys[monthKeys.length - 1])) {
    monthKeys.pop();
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const months = monthKeys.map((k) => ({
    month: k,
    available: round2(available.get(k)!),
    gross: round2(available.get(k)! + contribAddback.get(k)!),
  }));
  const availableMonthly = round2(months.reduce((s, m) => s + m.available, 0) / months.length);
  const grossMonthly = round2(months.reduce((s, m) => s + m.gross, 0) / months.length);

  const committedGoals = committed.map((g) => ({
    goalId: g.id,
    name: g.name,
    monthlyContribution: parseFloat(String(g.monthlyContribution)),
  }));
  const committedMonthlyTotal = round2(committedGoals.reduce((s, g) => s + g.monthlyContribution, 0));

  // Diagnostic leakage: trailing 6 complete months of checking outflows that
  // are not reconciled to a forecast row, not card payments, not transfers,
  // and match no active bill's merchant matcher.
  const leakage = await db.execute(sql`
    with matchers as (
      select lower(match_merchant) as m from bills
      where user_id = ${req.userId} and match_merchant is not null and match_merchant <> '' and is_active
    )
    select coalesce(sum(p.amount), 0)::numeric as total
    from plaid_transactions p
    join accounts a on a.plaid_account_id = p.account_id and a.user_id = p.user_id
    where p.user_id = ${req.userId}
      and a.account_type <> 'credit_card' and a.is_forecast_account
      and not p.pending and p.amount > 0
      and p.date >= (date_trunc('month', now()) - interval '6 months')::date
      and p.date < date_trunc('month', now())::date
      and coalesce(p.personal_finance_category_detailed, '') not like '%CREDIT_CARD%'
      and coalesce(p.personal_finance_category, '') not in ('TRANSFER_OUT', 'TRANSFER_IN')
      and not exists (select 1 from forecasted_transactions f where f.matched_plaid_transaction_id = p.id)
      and not exists (
        select 1 from matchers mm
        where lower(coalesce(p.merchant_name, p.name, '')) like '%' || mm.m || '%'
      )
  `);
  const leakageMonthly = round2(parseFloat(String((leakage.rows[0] as { total?: unknown })?.total ?? 0)) / 6);

  res.json(GetGoalSurplusResponse.parse({
    windowStart,
    windowEnd,
    availableMonthly,
    grossMonthly,
    committedMonthlyTotal,
    leakageMonthly,
    months,
    committedGoals,
  }));
});

router.get("/goals", async (req, res): Promise<void> => {
  const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, req.userId)).orderBy(goalsTable.createdAt);
  const serialized = await Promise.all(goals.map((g) => serializeGoalFull(req.userId, g)));
  res.json(ListGoalsResponse.parse(serialized));
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
      // ACTUAL bucket starts at alreadySaved (no reconciled contributions yet).
      actualBucket: String(core.alreadySaved),
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
  const { error, monthlyContribution: recomputed } = await validateGoalCore(req.userId, core);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  // COMMITTED goals: the contribution is a promise the user committed to.
  // Moving dates changes how much gets FUNDED, not the monthly amount —
  // that's what makes an underfunded spend goal (shortfall) representable.
  // The amount only recomputes when the target itself changes
  // (targetAmount / alreadySaved). Draft goals always recompute.
  const amountsChanged = b.targetAmount !== undefined || b.alreadySaved !== undefined;
  const monthlyContribution =
    existing.status === "committed" && !amountsChanged
      ? parseFloat(String(existing.monthlyContribution))
      : recomputed;
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
        // Keep the stored ACTUAL bucket in lockstep with alreadySaved edits
        // (reconciled − withdrawals delta carries over unchanged).
        ...(b.alreadySaved !== undefined && {
          actualBucket: String(
            Math.round(
              (parseFloat(String(existing.actualBucket)) - parseFloat(String(existing.alreadySaved)) + core.alreadySaved) * 100,
            ) / 100,
          ),
        }),
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
  res.json(UpdateGoalResponse.parse(await serializeGoalFull(req.userId, goal)));
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
  if (goal.status === "committed" || goal.billId != null) {
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
  res.json(CommitGoalResponse.parse(await serializeGoalFull(req.userId, updated.linked)));
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
  // 'cancelled' (purchase removed) goals still carry their contribution bill —
  // uncommit remains the way to unwind them fully.
  if ((goal.status !== "committed" && goal.status !== "cancelled" && goal.status !== "completed") || goal.billId == null) {
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
    // Clean removal: planned forecast rows first, then the bill. Spend-goal
    // purchase rows (both legs, including any "removed" markers) go with it —
    // balance must return to pre-commit EXACTLY.
    await db.transaction(async (tx) => {
      await tx
        .delete(forecastedTransactionsTable)
        .where(and(eq(forecastedTransactionsTable.userId, req.userId), eq(forecastedTransactionsTable.sourceBillId, goal.billId!)));
      await tx
        .delete(forecastedTransactionsTable)
        .where(and(
          eq(forecastedTransactionsTable.userId, req.userId),
          eq(forecastedTransactionsTable.sourceGoalId, goal.id),
          eq(forecastedTransactionsTable.isActual, false),
        ));
      await tx.update(goalsTable).set({ billId: null, status: "draft" }).where(eq(goalsTable.id, goal.id));
      await tx.delete(billsTable).where(and(eq(billsTable.id, goal.billId!), eq(billsTable.userId, req.userId)));
    });
  } else {
    // History exists: end-date + deactivate, keep the bill row and its
    // reconciled forecast rows intact. Future planned rows are cleaned up
    // by regeneration (bill inactive => no occurrences emitted). Planned
    // (non-actual) purchase rows still go — the purchase isn't happening.
    await db.transaction(async (tx) => {
      await tx
        .update(billsTable)
        .set({ endDate: toLocalIsoDate(new Date()), isActive: false })
        .where(and(eq(billsTable.id, goal.billId!), eq(billsTable.userId, req.userId)));
      await tx
        .delete(forecastedTransactionsTable)
        .where(and(
          eq(forecastedTransactionsTable.userId, req.userId),
          eq(forecastedTransactionsTable.sourceGoalId, goal.id),
          eq(forecastedTransactionsTable.isActual, false),
        ));
      await tx.update(goalsTable).set({ billId: null, status: "draft" }).where(eq(goalsTable.id, goal.id));
    });
  }

  await regenerateForecastForUser(req.userId);
  const [updated] = await db.select().from(goalsTable).where(eq(goalsTable.id, goal.id));
  req.log.info({ goalId: goal.id, billId: goal.billId, hadReconciled: reconciled.length > 0 }, "Uncommitted goal");
  res.json(UncommitGoalResponse.parse(await serializeGoalFull(req.userId, updated)));
});

/**
 * "DIDN'T HAPPEN" — the purchase isn't going to occur. Reuses the existing
 * removal idiom: status='removed' + isCommitted=true on BOTH purchase rows
 * (if the purchase doesn't happen, the funding transfer doesn't either).
 * Those rows survive regeneration, which suppresses re-emitting the pair.
 *
 * Goal status choice: 'cancelled' — the commit lifecycle ended without the
 * purchase. The saved money stays where it is (the contribution bill is left
 * untouched; it ends at the spend date on its own terms), and the goal never
 * auto-flips to 'completed'.
 */
router.post("/goals/:id/purchase-removed", async (req, res): Promise<void> => {
  const params = RemoveGoalPurchaseParams.safeParse(req.params);
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
  if (goal.goalType !== "spend") {
    res.status(400).json({ error: "Only spend goals have a purchase event." });
    return;
  }
  if (goal.status !== "committed" && goal.status !== "completed") {
    res.status(400).json({ error: "Goal has no committed purchase to remove." });
    return;
  }
  // Atomic + pair-strict: BOTH legs (purchase expense + funding income) must
  // exist; anything else is an integrity error, not a partial success.
  let updated: typeof goal;
  try {
    updated = await db.transaction(async (tx) => {
      const legs = await tx
        .select({ id: forecastedTransactionsTable.id, transactionType: forecastedTransactionsTable.transactionType })
        .from(forecastedTransactionsTable)
        .where(and(
          eq(forecastedTransactionsTable.userId, req.userId),
          eq(forecastedTransactionsTable.sourceGoalId, goal.id),
        ));
      const hasPair =
        legs.length === 2 &&
        legs.some((l) => l.transactionType === "expense") &&
        legs.some((l) => l.transactionType === "income");
      if (!hasPair) {
        throw new Error(`PAIR_INTEGRITY:${legs.length}`);
      }
      await tx
        .update(forecastedTransactionsTable)
        .set({ status: "removed", isCommitted: true })
        .where(and(
          eq(forecastedTransactionsTable.userId, req.userId),
          eq(forecastedTransactionsTable.sourceGoalId, goal.id),
        ));
      const [g] = await tx
        .update(goalsTable)
        .set({ status: "cancelled" })
        .where(eq(goalsTable.id, goal.id))
        .returning();
      return g;
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("PAIR_INTEGRITY")) {
      res.status(409).json({ error: "The goal's purchase rows are in an inconsistent state — refresh the forecast and try again." });
      return;
    }
    throw e;
  }
  req.log.info({ goalId: goal.id }, "Goal purchase marked removed");
  res.json(RemoveGoalPurchaseResponse.parse(await serializeGoalFull(req.userId, updated)));
});

export default router;
