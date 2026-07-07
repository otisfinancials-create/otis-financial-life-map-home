import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  assetsTable,
  billsTable,
  paySchedulesTable,
  loansTable,
  lifeEventsTable,
  userSettingsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendOtisChatBody, RunOtisScenarioBody, RunOtisScenarioResponse } from "@workspace/api-zod";

const MODEL = "claude-sonnet-4-6";
const HORIZON_MONTHS = 60;

const FREQ_TO_MONTHLY: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  "bi-weekly": 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
  yearly: 1 / 12,
};

const num = (v: unknown) => parseFloat(String(v)) || 0;

interface FinancialContext {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyCashFlow: number;
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  investedBalance: number;
  monthlyContribution: number;
  currentAge: number | null;
  retirementAge: number;
  retirementGoal: number | null;
  expectedReturnRate: number;
  loans: {
    id: number;
    loanName: string;
    loanType: string;
    currentBalance: number;
    interestRate: number;
    monthlyPayment: number;
  }[];
  summaryText: string;
}

async function buildFinancialContext(userId: string): Promise<FinancialContext> {
  const [accounts, assets, bills, paySchedules, loans, lifeEvents, settingsRows] =
    await Promise.all([
      db.select().from(accountsTable).where(eq(accountsTable.userId, userId)),
      db.select().from(assetsTable).where(eq(assetsTable.userId, userId)),
      db.select().from(billsTable).where(eq(billsTable.userId, userId)),
      db.select().from(paySchedulesTable).where(eq(paySchedulesTable.userId, userId)),
      db.select().from(loansTable).where(eq(loansTable.userId, userId)),
      db.select().from(lifeEventsTable).where(eq(lifeEventsTable.userId, userId)),
      // Known limitation: user_settings is a legacy single-user table keyed by
      // integer userId (always 1). The retirement routes share this pattern.
      // Migrating it to Clerk string user IDs is a separate schema change.
      db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, 1)).limit(1),
    ]);

  const settings = settingsRows[0];
  const holdings = [...accounts, ...assets];
  const totalAssets = holdings
    .filter((h) => h.isAsset)
    .reduce((s, h) => s + num(h.currentBalance), 0);
  const loanBalances = loans.reduce((s, l) => s + num(l.currentBalance), 0);
  const totalLiabilities =
    holdings.filter((h) => !h.isAsset).reduce((s, h) => s + num(h.currentBalance), 0) +
    loanBalances;
  const netWorth = totalAssets - totalLiabilities;

  const monthlyIncome = paySchedules.reduce(
    (s, p) => s + num(p.amount) * (FREQ_TO_MONTHLY[p.frequency.toLowerCase()] ?? 1),
    0,
  );
  const billsMonthly = bills
    .filter((b) => b.isActive)
    .reduce((s, b) => s + num(b.amount) * (FREQ_TO_MONTHLY[b.frequency.toLowerCase()] ?? 1), 0);
  const loanPaymentsMonthly = loans.reduce((s, l) => s + num(l.monthlyPayment), 0);
  const monthlyExpenses = billsMonthly + loanPaymentsMonthly;
  const monthlyCashFlow = monthlyIncome - monthlyExpenses;

  const investedAccounts = accounts.filter(
    (a) => a.isAsset && ["retirement", "investment"].includes(a.accountType),
  );
  const investedBalance = investedAccounts.reduce((s, a) => s + num(a.currentBalance), 0);
  const monthlyContribution = investedAccounts.reduce((s, a) => s + num(a.monthlyContribution), 0);

  const loanLines = loans.map(
    (l) =>
      `- ${l.loanName} (${l.loanType}): balance $${num(l.currentBalance).toLocaleString()}, rate ${num(l.interestRate)}%, payment $${num(l.monthlyPayment).toLocaleString()}/mo`,
  );
  const accountLines = accounts.map(
    (a) =>
      `- ${a.accountName} (${a.accountType}${a.isAsset ? "" : ", liability"}): $${num(a.currentBalance).toLocaleString()}`,
  );
  const lifeEventLines = lifeEvents
    .filter((e) => e.isActive)
    .map((e) => `- ${e.eventName} (${e.category}): $${num(e.amount).toLocaleString()}, ${e.timingType}`);

  const summaryText = [
    `Monthly income: $${Math.round(monthlyIncome).toLocaleString()}`,
    `Monthly expenses (bills + loan payments): $${Math.round(monthlyExpenses).toLocaleString()}`,
    `Monthly cash flow: $${Math.round(monthlyCashFlow).toLocaleString()}`,
    `Net worth: $${Math.round(netWorth).toLocaleString()} (assets $${Math.round(totalAssets).toLocaleString()}, liabilities $${Math.round(totalLiabilities).toLocaleString()})`,
    `Retirement/investment balance: $${Math.round(investedBalance).toLocaleString()}, contributing $${Math.round(monthlyContribution).toLocaleString()}/mo`,
    settings?.currentAge != null
      ? `Age ${settings.currentAge}, planning to retire at ${settings.retirementAge}${settings.retirementGoal ? `, goal $${num(settings.retirementGoal).toLocaleString()}` : ""}, expected return ${num(settings.expectedReturnRate ?? 7)}%`
      : `Retirement settings not yet configured (assume retirement age 65, 7% return)`,
    accountLines.length ? `Accounts:\n${accountLines.join("\n")}` : "No accounts on file.",
    loanLines.length ? `Loans:\n${loanLines.join("\n")}` : "No loans on file.",
    lifeEventLines.length ? `Planned life events:\n${lifeEventLines.join("\n")}` : "No planned life events.",
  ].join("\n");

  return {
    monthlyIncome,
    monthlyExpenses,
    monthlyCashFlow,
    netWorth,
    totalAssets,
    totalLiabilities,
    investedBalance,
    monthlyContribution,
    currentAge: settings?.currentAge ?? null,
    retirementAge: settings?.retirementAge ?? 65,
    retirementGoal: settings?.retirementGoal != null ? num(settings.retirementGoal) : null,
    expectedReturnRate: settings?.expectedReturnRate != null ? num(settings.expectedReturnRate) : 7,
    loans: loans.map((l) => ({
      id: l.id,
      loanName: l.loanName,
      loanType: l.loanType,
      currentBalance: num(l.currentBalance),
      interestRate: num(l.interestRate),
      monthlyPayment: num(l.monthlyPayment),
    })),
    summaryText,
  };
}

const OTIS_SYSTEM_PROMPT = `You are Otis, a warm, smart, and deeply personal financial advisor. You have access to the user's complete financial picture. You give clear, specific, actionable answers based on their real numbers — not generic advice. You are encouraging but honest. You explain things simply without jargon. When running what-if scenarios, always show the specific dollar impact on their monthly cash flow, net worth, and retirement projection. You have the personality of a loyal, intelligent dog who always has their owner's best interests at heart — friendly, attentive, and always making eye contact. Your answers are concise but complete. Never recommend specific investments or give regulated financial advice.`;

const router: IRouter = Router();

router.post("/otis/chat", async (req, res): Promise<void> => {
  const parsed = SendOtisChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const ctx = await buildFinancialContext(req.userId);
  const messages = parsed.data.messages.slice(-10);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8192,
      system: `${OTIS_SYSTEM_PROMPT}\n\nHere is the user's current financial picture:\n${ctx.summaryText}`,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    stream.on("text", (text) => {
      res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
    });

    await stream.finalMessage();
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Otis chat stream failed");
    res.write(`data: ${JSON.stringify({ error: "Otis had trouble responding. Please try again." })}\n\n`);
    res.end();
  }
});

// ── Scenario engine ───────────────────────────────────────────────────────────

interface ScenarioModel {
  /** Change in monthly cash flow at month m (0-indexed from now). */
  cashFlowDelta: (m: number) => number;
  /** One-time net worth hits: month -> amount (negative = cost). */
  oneTimeEvents: { month: number; amount: number }[];
  /** Extra monthly amount invested (earns returns), at month m. */
  investedDelta?: (m: number) => number;
  /** Multiplicative shock to invested balance at month m (e.g. -0.3 drop recovering). */
  investedShock?: (m: number) => number;
  /** Steady-state monthly cash flow impact reported on the impact card. */
  reportedMonthlyImpact: number;
  /** Optional pre-computed retirement label. */
  retirementLabel?: string;
}

function amortizedPayment(principal: number, annualRatePct: number, termMonths: number): number {
  if (principal <= 0 || termMonths <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

function monthsFromNow(dateStr: unknown): number {
  if (typeof dateStr !== "string" || !dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  const now = new Date();
  return Math.max(0, (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth()));
}

function simulateLoanPayoff(balance: number, annualRatePct: number, payment: number, extra: number) {
  const r = annualRatePct / 100 / 12;
  let bal = balance;
  let months = 0;
  let interest = 0;
  const monthly = payment + extra;
  while (bal > 0 && months < 600) {
    const i = bal * r;
    interest += i;
    bal = bal + i - monthly;
    months++;
    if (monthly <= i) break; // payment doesn't cover interest
  }
  return { months, interest };
}

function buildScenarioModel(
  type: string,
  inputs: Record<string, unknown>,
  ctx: FinancialContext,
): ScenarioModel {
  const n = (k: string, fallback = 0) => {
    const v = inputs[k];
    const parsed = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return isNaN(parsed) ? fallback : parsed;
  };
  const start = inputs["startDate"] ? monthsFromNow(inputs["startDate"]) : Math.round(n("startMonth", 0));

  switch (type) {
    case "job_change": {
      const newIncome = n("newMonthlyIncome", ctx.monthlyIncome);
      const delta = newIncome - ctx.monthlyIncome;
      const temporary = inputs["temporary"] === true;
      const duration = temporary ? Math.max(1, Math.round(n("durationMonths", 6))) : Infinity;
      const bonus = n("bonus", 0);
      return {
        cashFlowDelta: (m) => (m >= start && m < start + duration ? delta : 0),
        oneTimeEvents: bonus ? [{ month: start, amount: bonus }] : [],
        reportedMonthlyImpact: delta,
      };
    }
    case "buy_home": {
      const price = n("purchasePrice");
      const down = n("downPayment");
      const rate = n("mortgageRate", 6.5);
      const extras = n("monthlyExtras");
      const sellCurrent = inputs["sellCurrentHome"] === true;
      const salePrice = sellCurrent ? n("salePrice") : 0;
      const loanAmount = Math.max(0, price - down);
      const payment = amortizedPayment(loanAmount, rate, 360);
      const closingCosts = price * 0.03;
      const principalPerMonth = Math.max(0, payment - (loanAmount * rate) / 100 / 12);
      const sellingCosts = sellCurrent ? salePrice * 0.06 : 0;
      return {
        cashFlowDelta: (m) => (m >= start ? -(payment + extras) : 0),
        oneTimeEvents: [{ month: start, amount: -(closingCosts + sellingCosts) }],
        investedDelta: (m) => (m >= start ? principalPerMonth : 0),
        reportedMonthlyImpact: -(payment + extras),
      };
    }
    case "new_vehicle": {
      const price = n("vehiclePrice");
      const down = n("downPayment");
      const tradeIn = n("tradeInValue");
      const term = Math.round(n("termMonths", 60));
      const rate = n("interestRate", 7);
      const loanAmount = Math.max(0, price - down - tradeIn);
      const payment = amortizedPayment(loanAmount, rate, term);
      const depreciationHit = price * 0.1;
      return {
        cashFlowDelta: (m) => (m >= start && m < start + term ? -payment : 0),
        oneTimeEvents: [{ month: start, amount: -depreciationHit }],
        reportedMonthlyImpact: -payment,
      };
    }
    case "major_vacation": {
      const cost = n("totalCost");
      const method = String(inputs["paymentMethod"] ?? "cash");
      if (method === "credit_card") {
        const payment = amortizedPayment(cost, 22, 12);
        return {
          cashFlowDelta: (m) => (m >= start && m < start + 12 ? -payment : 0),
          oneTimeEvents: [],
          reportedMonthlyImpact: -payment,
        };
      }
      return {
        cashFlowDelta: () => 0,
        oneTimeEvents: [{ month: start, amount: -cost }],
        reportedMonthlyImpact: 0,
      };
    }
    case "extra_debt_payment": {
      const loanId = Math.round(n("loanId", -1));
      const extra = n("extraMonthly", 100);
      const loan = ctx.loans.find((l) => l.id === loanId) ?? ctx.loans[0];
      if (!loan) {
        return {
          cashFlowDelta: () => -extra,
          oneTimeEvents: [],
          reportedMonthlyImpact: -extra,
          retirementLabel: "No loans on file to pay down",
        };
      }
      const base = simulateLoanPayoff(loan.currentBalance, loan.interestRate, loan.monthlyPayment, 0);
      const accel = simulateLoanPayoff(loan.currentBalance, loan.interestRate, loan.monthlyPayment, extra);
      const monthsSaved = Math.max(0, base.months - accel.months);
      const interestSaved = Math.max(0, base.interest - accel.interest);
      return {
        cashFlowDelta: (m) => {
          if (m < accel.months) return -extra; // paying extra
          if (m < base.months) return loan.monthlyPayment; // loan gone early — payment freed up
          return 0;
        },
        oneTimeEvents: [],
        reportedMonthlyImpact: -extra,
        retirementLabel: `Debt-free ${monthsSaved} months sooner, saving $${Math.round(interestSaved).toLocaleString()} in interest`,
      };
    }
    case "market_downturn": {
      const dropPct = Math.abs(n("dropPct", 20)) / 100;
      const recoveryMonths = Math.max(1, Math.round(n("recoveryYears", 2) * 12));
      return {
        cashFlowDelta: () => 0,
        oneTimeEvents: [],
        investedShock: (m) => {
          if (m < 0) return 0;
          const recovered = Math.min(1, m / recoveryMonths);
          return -dropPct * (1 - recovered);
        },
        reportedMonthlyImpact: 0,
      };
    }
    case "education_expense": {
      const total = n("totalCost");
      const years = Math.max(0.5, n("durationYears", 4));
      const months = Math.round(years * 12);
      const monthly = total / months;
      return {
        cashFlowDelta: (m) => (m >= start && m < start + months ? -monthly : 0),
        oneTimeEvents: [],
        reportedMonthlyImpact: -monthly,
      };
    }
    case "growing_family": {
      const oneTime = n("oneTimeCost");
      const monthly = n("monthlyCost");
      const incomeChanges = inputs["incomeChange"] === true;
      const leaveDelta = incomeChanges ? -ctx.monthlyIncome * 0.5 : 0;
      return {
        cashFlowDelta: (m) => {
          let d = 0;
          if (m >= start) d -= monthly;
          if (incomeChanges && m >= start && m < start + 3) d += leaveDelta;
          return d;
        },
        oneTimeEvents: oneTime ? [{ month: start, amount: -oneTime }] : [],
        reportedMonthlyImpact: -monthly,
      };
    }
    case "early_retirement": {
      const currentAge = ctx.currentAge ?? 40;
      const newAge = Math.round(n("newRetirementAge", ctx.retirementAge));
      const yearsEarlier = ctx.retirementAge - newAge;
      const project = (targetAge: number) => {
        const months = Math.max(0, (targetAge - currentAge) * 12);
        const r = ctx.expectedReturnRate / 100 / 12;
        let bal = ctx.investedBalance;
        for (let i = 0; i < months; i++) bal = bal * (1 + r) + ctx.monthlyContribution;
        return bal;
      };
      const baselineVal = project(ctx.retirementAge);
      const scenarioVal = project(newAge);
      const diff = scenarioVal - baselineVal;
      return {
        cashFlowDelta: () => 0,
        oneTimeEvents: [],
        reportedMonthlyImpact: 0,
        retirementLabel:
          yearsEarlier > 0
            ? `Retiring ${yearsEarlier} year${yearsEarlier === 1 ? "" : "s"} earlier: $${Math.round(Math.abs(diff)).toLocaleString()} less at retirement`
            : yearsEarlier < 0
              ? `Retiring ${-yearsEarlier} year${yearsEarlier === -1 ? "" : "s"} later: $${Math.round(diff).toLocaleString()} more at retirement`
              : "No change to retirement timeline",
      };
    }
    case "major_purchase": {
      const cost = n("totalCost");
      const financed = String(inputs["paymentMethod"] ?? "cash") === "financing";
      if (financed) {
        const term = Math.max(1, Math.round(n("termMonths", 36)));
        const rate = n("interestRate", 9);
        const payment = amortizedPayment(cost, rate, term);
        return {
          cashFlowDelta: (m) => (m >= start && m < start + term ? -payment : 0),
          oneTimeEvents: [],
          reportedMonthlyImpact: -payment,
        };
      }
      return {
        cashFlowDelta: () => 0,
        oneTimeEvents: [{ month: start, amount: -cost }],
        reportedMonthlyImpact: 0,
      };
    }
    case "additional_savings": {
      const extra = n("extraMonthly", 200);
      const dest = String(inputs["destination"] ?? "general");
      const invested = dest === "retirement";
      return {
        cashFlowDelta: (m) => (m >= start ? -extra : 0),
        oneTimeEvents: [],
        // savings still count toward net worth; only growth differs
        investedDelta: (m) => (m >= start ? extra : 0),
        investedShock: undefined,
        reportedMonthlyImpact: -extra,
        retirementLabel: invested
          ? undefined
          : `$${Math.round(extra * 12).toLocaleString()}/year toward ${dest === "emergency_fund" ? "your emergency fund" : "general savings"}`,
      };
    }
    default:
      return { cashFlowDelta: () => 0, oneTimeEvents: [], reportedMonthlyImpact: 0 };
  }
}

function projectNetWorth(ctx: FinancialContext, model: ScenarioModel | null): number[] {
  const r = ctx.expectedReturnRate / 100 / 12;
  const values: number[] = [];
  let invested = ctx.investedBalance;
  let other = ctx.netWorth - ctx.investedBalance;
  for (let m = 0; m <= HORIZON_MONTHS; m++) {
    const shock = model?.investedShock ? model.investedShock(m) : 0;
    values.push(other + invested * (1 + shock));
    // advance one month
    invested = invested * (1 + r) + ctx.monthlyContribution;
    other += ctx.monthlyCashFlow - ctx.monthlyContribution;
    if (model) {
      // Cash flow deltas hit liquid net worth; invested deltas earn returns.
      other += model.cashFlowDelta(m);
      invested += model.investedDelta ? model.investedDelta(m) : 0;
      for (const e of model.oneTimeEvents) {
        if (e.month === m) other += e.amount;
      }
    }
  }
  return values;
}

function monthLabel(offset: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

router.post("/otis/scenario", async (req, res): Promise<void> => {
  const parsed = RunOtisScenarioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { scenarioType, inputs } = parsed.data;
  const ctx = await buildFinancialContext(req.userId);
  const model = buildScenarioModel(scenarioType, inputs as Record<string, unknown>, ctx);

  const baseline = projectNetWorth(ctx, null);
  const scenario = projectNetWorth(ctx, model);

  const points = [];
  for (let m = 0; m <= HORIZON_MONTHS; m += 3) {
    points.push({
      monthIndex: m,
      label: monthLabel(m),
      baseline: Math.round(baseline[m]),
      scenario: Math.round(scenario[m]),
    });
  }

  const netWorthImpactOneYear = Math.round(scenario[12] - baseline[12]);
  const monthlyCashFlowImpact = Math.round(model.reportedMonthlyImpact);

  let retirementImpactLabel = model.retirementLabel;
  if (!retirementImpactLabel) {
    const endDiff = scenario[HORIZON_MONTHS] - baseline[HORIZON_MONTHS];
    if (Math.abs(endDiff) < 500) {
      retirementImpactLabel = "No significant retirement impact";
    } else {
      // Project the 5-year difference forward to retirement age at the expected return.
      const yearsToRetirement =
        ctx.currentAge != null ? Math.max(0, ctx.retirementAge - ctx.currentAge - 5) : 20;
      const grown = endDiff * Math.pow(1 + ctx.expectedReturnRate / 100, yearsToRetirement);
      retirementImpactLabel = `~$${Math.round(Math.abs(grown)).toLocaleString()} ${grown >= 0 ? "more" : "less"} at retirement`;
    }
  }

  let commentary: string;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: OTIS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `I just ran a "${scenarioType.replace(/_/g, " ")}" what-if scenario. My financial picture:\n${ctx.summaryText}\n\nScenario inputs: ${JSON.stringify(inputs)}\n\nComputed results:\n- Monthly cash flow impact: ${monthlyCashFlowImpact >= 0 ? "+" : "-"}$${Math.abs(monthlyCashFlowImpact).toLocaleString()}/month\n- Net worth impact at 1 year: ${netWorthImpactOneYear >= 0 ? "+" : "-"}$${Math.abs(netWorthImpactOneYear).toLocaleString()}\n- Retirement impact: ${retirementImpactLabel}\n\nGive me a 2-3 sentence plain-English summary of what this means for me. Be specific with the numbers. Do not use markdown formatting or bullet points.`,
        },
      ],
    });
    commentary = msg.content
      .filter((b): b is { type: "text"; text: string; citations: never } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    req.log.error({ err }, "Otis commentary generation failed");
    commentary = `This scenario changes your monthly cash flow by ${monthlyCashFlowImpact >= 0 ? "+" : "-"}$${Math.abs(monthlyCashFlowImpact).toLocaleString()} per month and your net worth by ${netWorthImpactOneYear >= 0 ? "+" : "-"}$${Math.abs(netWorthImpactOneYear).toLocaleString()} after one year. ${retirementImpactLabel}.`;
  }

  res.json(
    RunOtisScenarioResponse.parse({
      monthlyCashFlowImpact,
      netWorthImpactOneYear,
      retirementImpactLabel,
      points,
      commentary,
    }),
  );
});

export default router;
