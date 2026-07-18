import { Router, type IRouter } from "express";
import { asc, desc, eq } from "drizzle-orm";
import {
  db,
  accountsTable,
  assetsTable,
  billsTable,
  paySchedulesTable,
  loansTable,
  lifeEventsTable,
  userSettingsTable,
  otisConversationsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { SendOtisChatBody, RunOtisScenarioBody, RunOtisScenarioResponse } from "@workspace/api-zod";
import { dedupedLoans, loanMatchesBill } from "../lib/financial-dedup";
import { getOtisCachedResponse, setOtisCachedResponse, type OtisCacheKey } from "../lib/otis-cache";

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
      db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, userId)).limit(1),
    ]);

  const settings = settingsRows[0];
  const holdings = [...accounts, ...assets];
  const totalAssets = holdings
    .filter((h) => h.isAsset)
    .reduce((s, h) => s + num(h.currentBalance), 0);
  const liabilityAccounts = accounts.filter((a) => !a.isAsset);
  const accountLiabilities = holdings
    .filter((h) => !h.isAsset)
    .reduce((s, h) => s + Math.abs(num(h.currentBalance)), 0);
  // Loans already represented as a liability Connected Account are not
  // double-counted — the account balance is the source of truth.
  const uniqueLoans = dedupedLoans(loans, liabilityAccounts);
  const totalLiabilities =
    accountLiabilities + uniqueLoans.reduce((s, l) => s + Math.abs(num(l.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  const monthlyIncome = paySchedules.reduce(
    (s, p) => s + num(p.amount) * (FREQ_TO_MONTHLY[p.frequency.toLowerCase()] ?? 1),
    0,
  );
  const activeBills = bills.filter((b) => b.isActive);
  const billsMonthly = activeBills.reduce(
    (s, b) => s + num(b.amount) * (FREQ_TO_MONTHLY[b.frequency.toLowerCase()] ?? 1),
    0,
  );
  // A loan whose payment closely matches an existing bill (name or amount
  // within 5%) is already counted in bills — never count it twice.
  const loansNotInBills = loans.filter((l) => !activeBills.some((b) => loanMatchesBill(l, b)));
  const loanPaymentsMonthly = loansNotInBills.reduce((s, l) => s + num(l.monthlyPayment), 0);
  const monthlyExpenses = billsMonthly + loanPaymentsMonthly;
  const monthlyCashFlow = monthlyIncome - monthlyExpenses;

  const investedAccounts = accounts.filter(
    (a) => a.isAsset && ["retirement", "investment"].includes(a.accountType),
  );
  const investedBalance = investedAccounts.reduce((s, a) => s + num(a.currentBalance), 0);
  const monthlyContribution = investedAccounts.reduce((s, a) => s + num(a.monthlyContribution), 0);

  // Compressed structured context (never raw rows). Next 5 upcoming bills only.
  const today = new Date();
  const upcomingBills = activeBills
    .map((b) => {
      let due = new Date(today.getFullYear(), today.getMonth(), b.dueDay);
      if (due < today) due = new Date(today.getFullYear(), today.getMonth() + 1, b.dueDay);
      return { name: b.billName, amount: num(b.amount), dueDate: due.toISOString().slice(0, 10) };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);

  const billsByCategoryMap = new Map<string, number>();
  for (const b of activeBills) {
    const monthly = num(b.amount) * (FREQ_TO_MONTHLY[b.frequency.toLowerCase()] ?? 1);
    billsByCategoryMap.set(b.category, (billsByCategoryMap.get(b.category) ?? 0) + monthly);
  }

  const retirementAge = settings?.retirementAge ?? 65;
  const currentAge = settings?.currentAge ?? null;
  const returnRate = settings?.expectedReturnRate != null ? num(settings.expectedReturnRate) : 7;
  const retirementGoal = settings?.retirementGoal != null ? num(settings.retirementGoal) : null;
  const monthsToRetirement = currentAge != null ? Math.max(0, (retirementAge - currentAge) * 12) : 300;
  let projectedValue = investedBalance;
  const mr = returnRate / 100 / 12;
  for (let i = 0; i < monthsToRetirement; i++) projectedValue = projectedValue * (1 + mr) + monthlyContribution;
  const readinessScore =
    retirementGoal == null || retirementGoal === 0
      ? 100
      : Math.min(100, Math.round((projectedValue / retirementGoal) * 100));

  const payoffDate = (l: (typeof loans)[number]) => {
    const bal = num(l.currentBalance);
    const pay = num(l.monthlyPayment);
    const r = num(l.interestRate) / 100 / 12;
    if (pay <= 0 || bal <= 0) return null;
    if (pay <= bal * r) return null;
    const n = r === 0 ? bal / pay : -Math.log(1 - (r * bal) / pay) / Math.log(1 + r);
    const d = new Date();
    d.setMonth(d.getMonth() + Math.ceil(n));
    return d.toISOString().slice(0, 7);
  };

  const contextObject = {
    summary: {
      netWorth: Math.round(netWorth),
      totalAssets: Math.round(totalAssets),
      totalLiabilities: Math.round(totalLiabilities),
      monthlyCashFlow: Math.round(monthlyCashFlow),
      monthlyIncome: Math.round(monthlyIncome),
      monthlyExpenses: Math.round(monthlyExpenses),
    },
    income: paySchedules.map((p) => ({
      name: p.employerName,
      monthlyAmount: Math.round(num(p.amount) * (FREQ_TO_MONTHLY[p.frequency.toLowerCase()] ?? 1)),
    })),
    billsByCategory: [...billsByCategoryMap.entries()].map(([category, monthlyTotal]) => ({
      category,
      monthlyTotal: Math.round(monthlyTotal),
    })),
    loans: loans.map((l) => ({
      name: l.loanName,
      balance: num(l.currentBalance),
      rate: num(l.interestRate),
      monthlyPayment: num(l.monthlyPayment),
      payoffDate: payoffDate(l),
    })),
    retirement: {
      currentSavings: Math.round(investedBalance),
      monthlyContribution: Math.round(monthlyContribution),
      projectedValue: Math.round(projectedValue),
      readinessScore,
    },
    upcomingBills,
    lifeEvents: lifeEvents
      .filter((e) => e.isActive)
      .map((e) => ({
        name: e.eventName,
        amount: num(e.amount),
        date: e.eventDate || e.startDate || null,
        priority: e.priority,
      })),
  };

  const summaryText = JSON.stringify(contextObject);

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

const OTIS_SYSTEM_PROMPT = `You are Otis, the user's personal financial advisor — warm, loyal, and sharp, with the attentive personality of a smart golden-hearted dog. You know their full financial picture (provided as structured JSON below) and answer with their real numbers, never generic advice.

Tone:
- Never say "I suggest" or "you should". Frame guidance as options: "Here are some options..." or "You could consider...". Never be prescriptive or directive.
- Always warm, positive, and completely non-judgmental regardless of their situation. Never imply criticism of past decisions. You are a supportive best friend, not a financial critic.
- Reference earlier conversation naturally when relevant. If asked something outside their finances, gently steer back.
- Never recommend specific investments or give regulated financial/tax/legal advice; point to a professional for those.

Formatting:
- Be concise. Simple questions get 1-3 sentences.
- Plain language, no jargon. All dollar amounts as $X,XXX with commas.
- Markdown allowed: **bold** key figures, short bullet lists, tables of 2-3 columns max. No emoji in section headers. Single blank line between sections, never double. One sentence of insight per section maximum.
- Health scores: bold number, then a simple two-column strengths vs opportunities table.
- No filler phrases like "genuinely strong", "That's not catastrophic", "I want to make sure", "I'm all ears".
- End every comprehensive response with exactly one follow-up question or offer — never a list of options.
- When a "Computed facts" block is provided, use those exact numbers — never recompute or estimate loan math.`;

/** Detect a simple cacheable question ("what's my net worth / cash flow"). */
function detectCacheableQuestion(text: string): OtisCacheKey | null {
  const t = text.toLowerCase().trim();
  if (t.length > 80) return null;
  if (/net\s*worth/.test(t)) return "net_worth";
  if (/cash\s*flow/.test(t)) return "cash_flow";
  return null;
}

function closedFormPayoffMonths(balance: number, annualRatePct: number, payment: number): number | null {
  if (balance <= 0 || payment <= 0) return null;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return null;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}

/**
 * Deterministic extra-payment math (#3): if the user's message looks like an
 * extra-payment question, compute exact payoff/interest deltas server-side
 * and pass them to the model as facts.
 */
function buildExtraPaymentFacts(userText: string, ctx: FinancialContext): string | null {
  const t = userText.toLowerCase();
  if (!/(extra|additional|more)\b/.test(t) || !/(pay|payment|loan|mortgage|debt)/.test(t)) return null;
  const amountMatch = t.match(/\$?\s*([\d][\d,]*(?:\.\d+)?)/);
  if (!amountMatch?.[1]) return null;
  const extra = parseFloat(amountMatch[1].replace(/,/g, ""));
  if (!isFinite(extra) || extra <= 0 || ctx.loans.length === 0) return null;

  // Prefer a loan mentioned by name; otherwise compute for all loans.
  const mentioned = ctx.loans.filter((l) =>
    l.loanName
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length > 3 && t.includes(w)),
  );
  const targets = mentioned.length > 0 ? mentioned : ctx.loans;

  const lines: string[] = [];
  for (const loan of targets) {
    const baseMonths = closedFormPayoffMonths(loan.currentBalance, loan.interestRate, loan.monthlyPayment);
    const newMonths = closedFormPayoffMonths(loan.currentBalance, loan.interestRate, loan.monthlyPayment + extra);
    if (baseMonths == null || newMonths == null) continue;
    const baseInterest = baseMonths * loan.monthlyPayment - loan.currentBalance;
    const newInterest = newMonths * (loan.monthlyPayment + extra) - loan.currentBalance;
    const monthsSaved = Math.max(0, baseMonths - newMonths);
    const interestSaved = Math.max(0, baseInterest - newInterest);
    lines.push(
      `${loan.loanName}: current payoff ${baseMonths} months; with $${extra.toLocaleString()}/mo extra, payoff ${newMonths} months (${monthsSaved} months sooner), interest saved ~$${Math.round(interestSaved).toLocaleString()}.`,
    );
  }
  if (lines.length === 0) return null;
  return `Computed facts (exact math for an extra $${extra.toLocaleString()}/month payment — use these numbers):\n${lines.join("\n")}`;
}

const HISTORY_LIMIT = 20;

async function loadHistory(userId: string) {
  const rows = await db
    .select()
    .from(otisConversationsTable)
    .where(eq(otisConversationsTable.userId, userId))
    .orderBy(desc(otisConversationsTable.createdAt), desc(otisConversationsTable.id))
    .limit(HISTORY_LIMIT);
  return rows.reverse();
}

/** Merge consecutive same-role messages (Anthropic requires alternation). */
function normalizeMessages(msgs: { role: "user" | "assistant"; content: string }[]) {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of msgs) {
    if (!m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

const router: IRouter = Router();

router.get("/otis/history", async (req, res): Promise<void> => {
  const rows = await loadHistory(req.userId);
  res.json(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.post("/otis/chat", async (req, res): Promise<void> => {
  const parsed = SendOtisChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const incoming = parsed.data.messages;
  const latestUser = [...incoming].reverse().find((m) => m.role === "user");
  const userText = latestUser?.content ?? "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Cached instant answers for simple repeat questions (net worth / cash flow).
  const cacheKey = detectCacheableQuestion(userText);
  if (cacheKey) {
    const cached = await getOtisCachedResponse(req.userId, cacheKey);
    if (cached) {
      try {
        await db.insert(otisConversationsTable).values([
          { userId: req.userId, role: "user", content: userText },
          { userId: req.userId, role: "assistant", content: cached.content },
        ]);
      } catch (err) {
        req.log.error({ err }, "Failed to persist cached Otis exchange");
      }
      res.write(`data: ${JSON.stringify({ content: cached.content })}\n\n`);
      res.write(`data: ${JSON.stringify({ cachedAsOf: cached.lastUpdated.toISOString() })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }
  }

  try {
    // Context: persisted history (across sessions) + this session's messages.
    const [ctx, history] = await Promise.all([
      buildFinancialContext(req.userId),
      loadHistory(req.userId),
    ]);
    const sessionMsgs = incoming.map((m) => ({ role: m.role, content: m.content }));
    const historyMsgs = history.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    }));
    // Drop history entries duplicated in the session payload (already persisted turns).
    const sessionSet = new Set(sessionMsgs.map((m) => `${m.role}:${m.content}`));
    const priorMsgs = historyMsgs.filter((h) => !sessionSet.has(`${h.role}:${h.content}`));
    const messages = normalizeMessages([...priorMsgs, ...sessionMsgs].slice(-HISTORY_LIMIT - 2));

    const facts = buildExtraPaymentFacts(userText, ctx);
    const system = [
      OTIS_SYSTEM_PROMPT,
      `\nUser's current financial picture (JSON):\n${ctx.summaryText}`,
      facts ? `\n${facts}` : "",
    ].join("\n");

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages,
    });

    stream.on("text", (text) => {
      res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
    });

    const finalMsg = await stream.finalMessage();
    const assistantText = finalMsg.content
      .filter((b): b is Extract<(typeof finalMsg.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (userText && assistantText) {
      try {
        await db.insert(otisConversationsTable).values([
          { userId: req.userId, role: "user", content: userText },
          { userId: req.userId, role: "assistant", content: assistantText },
        ]);
        if (cacheKey) await setOtisCachedResponse(req.userId, cacheKey, assistantText);
      } catch (err) {
        req.log.error({ err }, "Failed to persist Otis exchange");
      }
    }

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
