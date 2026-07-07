import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, userSettingsTable, accountsTable } from "@workspace/db";
import {
  SaveRetirementSettingsBody,
  GetRetirementSettingsResponse,
  SaveRetirementSettingsResponse,
  GetRetirementSummaryResponse,
  GetRetirementProjectionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Account types counted toward the retirement savings base. Investment accounts
// are included intentionally (e.g. a brokerage earmarked for retirement).
const RETIREMENT_ACCOUNT_TYPES = ["retirement", "investment"];

const DEFAULTS = {
  currentAge: null as number | null,
  retirementAge: 65,
  retirementGoal: null as number | null,
  expectedReturnRate: 7,
  inflationRate: 3,
  monthlySpendingGoal: null as number | null,
  socialSecurityMonthly: null as number | null,
  retirementDurationYears: 25,
};

function toNum(v: string | null): number | null {
  return v === null ? null : parseFloat(String(v));
}

function serializeSettings(s: typeof userSettingsTable.$inferSelect) {
  return {
    currentAge: s.currentAge,
    retirementAge: s.retirementAge,
    retirementGoal: toNum(s.retirementGoal),
    expectedReturnRate: parseFloat(String(s.expectedReturnRate)),
    inflationRate: parseFloat(String(s.inflationRate)),
    monthlySpendingGoal: toNum(s.monthlySpendingGoal),
    socialSecurityMonthly: toNum(s.socialSecurityMonthly),
    retirementDurationYears: s.retirementDurationYears,
  };
}

async function loadSettings() {
  const [row] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, 1))
    .limit(1);
  return row ? serializeSettings(row) : { ...DEFAULTS };
}

async function loadRetirementAccounts(userId: string) {
  return db
    .select()
    .from(accountsTable)
    .where(
      and(
        eq(accountsTable.userId, userId),
        eq(accountsTable.isAsset, true),
        inArray(accountsTable.accountType, RETIREMENT_ACCOUNT_TYPES),
      ),
    );
}

// Monthly-compounded growth with monthly contributions, reported year by year.
export function projectRetirement(
  currentSavings: number,
  monthlyContribution: number,
  currentAge: number,
  retirementAge: number,
  annualReturnPct: number,
): { age: number; year: number; projected: number }[] {
  const monthlyRate = annualReturnPct / 100 / 12;
  const startYear = new Date().getFullYear();
  const points: { age: number; year: number; projected: number }[] = [];
  let balance = currentSavings;
  points.push({ age: currentAge, year: startYear, projected: Math.round(balance) });
  for (let age = currentAge + 1; age <= retirementAge; age++) {
    for (let m = 0; m < 12; m++) {
      balance = balance * (1 + monthlyRate) + monthlyContribution;
    }
    points.push({ age, year: startYear + (age - currentAge), projected: Math.round(balance) });
  }
  return points;
}

router.get("/retirement/settings", async (_req, res): Promise<void> => {
  const settings = await loadSettings();
  res.json(GetRetirementSettingsResponse.parse(settings));
});

router.post("/retirement/settings", async (req, res): Promise<void> => {
  const parsed = SaveRetirementSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.retirementAge <= parsed.data.currentAge) {
    res.status(400).json({ error: "Planned retirement age must be greater than your current age" });
    return;
  }

  const values = {
    currentAge: parsed.data.currentAge,
    retirementAge: parsed.data.retirementAge,
    retirementGoal: String(parsed.data.retirementGoal),
    expectedReturnRate: String(parsed.data.expectedReturnRate),
    inflationRate: String(parsed.data.inflationRate),
    monthlySpendingGoal: String(parsed.data.monthlySpendingGoal),
    socialSecurityMonthly:
      parsed.data.socialSecurityMonthly != null ? String(parsed.data.socialSecurityMonthly) : null,
    retirementDurationYears: parsed.data.retirementDurationYears,
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, 1))
    .limit(1);

  let saved: typeof userSettingsTable.$inferSelect;
  if (existing) {
    [saved] = await db
      .update(userSettingsTable)
      .set(values)
      .where(eq(userSettingsTable.userId, 1))
      .returning();
  } else {
    [saved] = await db
      .insert(userSettingsTable)
      .values({
        userId: 1,
        balanceAsOfDate: new Date().toISOString().split("T")[0],
        ...values,
      })
      .returning();
  }
  req.log.info("Saved retirement settings");
  res.json(SaveRetirementSettingsResponse.parse(serializeSettings(saved)));
});

router.get("/retirement/summary", async (req, res): Promise<void> => {
  const [settings, accounts] = await Promise.all([
    loadSettings(),
    loadRetirementAccounts(req.userId),
  ]);

  const currentSavings = accounts.reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const monthlyContribution = accounts.reduce(
    (sum, a) => sum + parseFloat(String(a.monthlyContribution)),
    0,
  );

  const hasSettings = settings.currentAge != null && settings.retirementGoal != null;
  let projectedValue = currentSavings;
  if (settings.currentAge != null && settings.retirementAge > settings.currentAge) {
    const points = projectRetirement(
      currentSavings,
      monthlyContribution,
      settings.currentAge,
      settings.retirementAge,
      settings.expectedReturnRate,
    );
    projectedValue = points[points.length - 1].projected;
  }
  const readinessScore =
    settings.retirementGoal && settings.retirementGoal > 0
      ? Math.min(100, Math.round((projectedValue / settings.retirementGoal) * 100))
      : 0;

  res.json(
    GetRetirementSummaryResponse.parse({
      currentSavings: Math.round(currentSavings * 100) / 100,
      projectedValue,
      monthlyContribution: Math.round(monthlyContribution * 100) / 100,
      readinessScore,
      retirementGoal: settings.retirementGoal,
      hasSettings,
    }),
  );
});

router.get("/retirement/projection", async (req, res): Promise<void> => {
  const [settings, accounts] = await Promise.all([
    loadSettings(),
    loadRetirementAccounts(req.userId),
  ]);

  const currentSavings = accounts.reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const monthlyContribution = accounts.reduce(
    (sum, a) => sum + parseFloat(String(a.monthlyContribution)),
    0,
  );

  const hasSettings = settings.currentAge != null && settings.retirementGoal != null;
  if (settings.currentAge == null || settings.retirementAge <= settings.currentAge) {
    res.json(
      GetRetirementProjectionResponse.parse({
        points: [],
        projectedValue: Math.round(currentSavings),
        retirementGoal: settings.retirementGoal,
        onTrack: false,
        shortfall: settings.retirementGoal ?? 0,
        hasSettings,
      }),
    );
    return;
  }

  const points = projectRetirement(
    currentSavings,
    monthlyContribution,
    settings.currentAge,
    settings.retirementAge,
    settings.expectedReturnRate,
  );
  const projectedValue = points[points.length - 1].projected;
  const goal = settings.retirementGoal ?? 0;
  const onTrack = goal > 0 && projectedValue >= goal;
  const shortfall = onTrack ? 0 : Math.max(0, goal - projectedValue);

  res.json(
    GetRetirementProjectionResponse.parse({
      points,
      projectedValue,
      retirementGoal: settings.retirementGoal,
      onTrack,
      shortfall,
      hasSettings,
    }),
  );
});

export default router;
