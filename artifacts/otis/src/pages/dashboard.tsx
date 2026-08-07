import {
  useGetDashboardSummary,
  useListAccounts,
  useGetMonthlyForecast,
  useListBills,
  useListForecast,
  useListLoans,
  useListAssets,

  useGetRetirementSummary,
  useListCardCompositions,
  getListForecastQueryKey,
} from "@workspace/api-client-react";
import {
  NetWorthModal,
  CashFlowModal,
  SavingsInvestmentsModal,
  BillsSnapshotModal,
} from "@/components/dashboard/breakdown-modals";
import { useState, useMemo } from "react";
import { foldCarryover } from "@/components/bills/card-composition";
import { useBudgetMath } from "@/hooks/use-budget-math";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Wallet,
  TrendingUp,
  PiggyBank,
  CalendarHeart,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import {
  AreaChart,
  ComposedChart,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { categoryMeta, categoryDisplayLabel, accountTypeMeta } from "@/utils/categoryIcons";
import { format, startOfMonth, endOfMonth, addMonths, addDays, differenceInCalendarDays } from "date-fns";
import { Link, useLocation } from "wouter";
import type { ReactNode } from "react";

const fmt = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);

// Shared "premium" card chrome: 12px radius, 1px light border, subtle shadow.
const cardChrome = "rounded-xl border border-border bg-card shadow-sm";

/* ── Trend badge ──────────────────────────────────────────────────────── */

// Honest flat indicator for values that come from recurring schedules
// (bills + pay schedules) where no prior-month measurement exists.
function SteadyBadge() {
  return (
    <p
      className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"
      title="This figure comes from your recurring bills and pay, so it stays steady month to month unless you change them."
    >
      <Minus className="h-3 w-3" />
      <span>steady · recurring</span>
    </p>
  );
}

function TrendBadge({
  current,
  previous,
  positiveIsGood = true,
  estimated = false,
}: {
  current: number;
  previous: number | null;
  positiveIsGood?: boolean;
  estimated?: boolean;
}) {
  if (previous === null || previous === 0) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />
        <span>no prior month data</span>
      </p>
    );
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const good = flat ? null : up === positiveIsGood;
  const colorClass = flat
    ? "text-muted-foreground"
    : good
      ? "text-emerald-600"
      : "text-red-600";
  return (
    <p
      className={`mt-1.5 flex items-center gap-1 text-xs font-medium ${colorClass}`}
      title={
        estimated
          ? "Modeled estimate — no historical snapshots yet. Derived from your monthly cash flow and debt payments."
          : undefined
      }
    >
      {flat ? (
        <Minus className="h-3 w-3" />
      ) : up ? (
        <ArrowUpRight className="h-3.5 w-3.5" />
      ) : (
        <ArrowDownRight className="h-3.5 w-3.5" />
      )}
      <span className="font-mono tabular-nums">
        {flat ? "0.0%" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
      </span>
      <span className="text-muted-foreground font-normal">
        vs last month{estimated ? " (est.)" : ""}
      </span>
    </p>
  );
}

/* ── Metric card ──────────────────────────────────────────────────────── */

function MetricCard({
  title,
  icon,
  accent,
  loading,
  value,
  valueClass = "",
  trend,
  subline,
  onClick,
}: {
  title: string;
  icon: ReactNode;
  accent: string;
  loading: boolean;
  value: ReactNode;
  valueClass?: string;
  trend: ReactNode;
  subline: ReactNode;
  onClick: () => void;
}) {
  return (
    <Card
      className={`${cardChrome} cursor-pointer transition-all duration-150 hover:shadow-md group overflow-hidden`}
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <span style={{ color: accent }} className="opacity-70 group-hover:opacity-100 transition-opacity">
          {icon}
        </span>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-[140px]" />
        ) : (
          <>
            <div
              className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${valueClass}`}
              style={{ color: "#0D2B45" }}
            >
              {value}
            </div>
            {trend}
            <p className="text-xs text-muted-foreground mt-1.5 flex items-center justify-between">
              {subline}
              <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Muted chart colors (≈20% less saturation, 6 Month View only) ─────── */

function softenColor(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const num = parseInt(m[1]!, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  // Desaturate by mixing each channel 20% toward the luminance gray
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c: number) => Math.round(c + (gray - c) * 0.2);
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/* ── 6 Month View tooltip ─────────────────────────────────────────────── */

// Card envelopes are a first-class stacked series, not a bill category.
const SIX_MONTH_ENVELOPES_KEY = "cardEnvelopes";
const ENVELOPES_COLOR = "#534AB7";

function sixMonthSeriesLabel(key: string): string {
  if (key === SIX_MONTH_ENVELOPES_KEY) return "Card Envelopes";
  // Display label, not canonical bucket: custom categories ("Home
  // Maintenance") keep their own name instead of collapsing into "Other",
  // which previously produced two identical "Other" legend entries.
  return categoryDisplayLabel(key);
}

function sixMonthSeriesColor(key: string): string {
  if (key === SIX_MONTH_ENVELOPES_KEY) return ENVELOPES_COLOR;
  return categoryMeta(key).color;
}

function SixMonthTooltip({
  active,
  payload,
  label,
  categories,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number }>;
  label?: string;
  categories: string[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const byKey = new Map<string, number>();
  payload.forEach((p) => {
    if (p.dataKey != null) byKey.set(String(p.dataKey), Number(p.value ?? 0));
  });
  const row = (payload[0] as { payload?: Record<string, number> } | undefined)?.payload;
  const income = Number(row?.income ?? 0);
  const expenses = categories.reduce((s, c) => s + (byKey.get(c) ?? 0), 0);
  const net = income - expenses;
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-md text-xs space-y-1 min-w-[180px]">
      <p className="font-semibold text-sm mb-1">{label}</p>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Income</span>
        <span className="font-mono tabular-nums font-medium text-emerald-600">{fmt(income)}</span>
      </div>
      {categories.map((c) => (
        <div key={c} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: sixMonthSeriesColor(c) }}
            />
            <span className="text-muted-foreground">{sixMonthSeriesLabel(c)}</span>
          </span>
          <span className="font-mono tabular-nums">{fmt(byKey.get(c) ?? 0)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-4 pt-1 mt-1 border-t border-border">
        <span className="font-medium">Net cash flow</span>
        <span
          className={`font-mono tabular-nums font-semibold ${
            net >= 0 ? "text-emerald-600" : "text-red-600"
          }`}
        >
          {fmt(net)}
        </span>
      </div>
    </div>
  );
}

/* ── Dashboard ────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: monthlyForecast, isLoading: isLoadingForecast } = useGetMonthlyForecast();
  const { data: bills, isLoading: isLoadingBills } = useListBills();
  const { data: loans } = useListLoans();
  const { data: assets } = useListAssets();
  const { data: retirementSummary, isLoading: isLoadingRetirement } = useGetRetirementSummary();

  const [netWorthOpen, setNetWorthOpen] = useState(false);
  const [cashFlowOpen, setCashFlowOpen] = useState(false);
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [billsSnapshotOpen, setBillsSnapshotOpen] = useState(false);

  const today = new Date();
  const monthStartStr = format(startOfMonth(today), "yyyy-MM-dd");
  const snapshotEndStr = format(addDays(today, 60), "yyyy-MM-dd");
  const { data: forecastTxs } = useListForecast({
    startDate: monthStartStr,
    endDate: snapshotEndStr,
  });

  /* ── Monthly-equivalent income & bills ──────────────────────────────── */
  // Single source of truth shared with the Budget tab, the cash-flow modal,
  // Bills Snapshot, and the goals surplus readouts. Monthly-average surfaces
  // normalize cadence (a quarterly bill contributes 1/3 per month) and include
  // card envelopes + card-paid bills — the opposite of the 6 Month View /
  // Planned vs Actual, which show actual occurrences without normalization.
  const budget = useBudgetMath();
  const payMonthly = budget.monthlyIncome;
  const billsMonthlyTotal = budget.totalBills;
  const avgMonthlyCashFlow = budget.netCashFlow;

  /* ── 6 Month View chart data ────────────────────────────────────────── */
  // Real per-month amounts from forecast occurrences — NO cadence
  // normalization. A quarterly bill appears at full amount only in its
  // occurrence months; biweekly pay shows three-paycheck months. Card
  // envelopes and card-paid bills come from cycle compositions (attributed to
  // the month the CYCLE CLOSES, same as Planned vs Actual), with the same
  // precedence rule: forecast rows win, cycle rows only for bills with no
  // forecast occurrence that month — the is_cc_parent aggregate is skipped so
  // each dollar is counted exactly once.
  const sixMonthStart = format(startOfMonth(today), "yyyy-MM-dd");
  const sixMonthEnd = format(endOfMonth(addMonths(today, 5)), "yyyy-MM-dd");
  const { data: sixMonthTxs } = useListForecast(
    { startDate: sixMonthStart, endDate: sixMonthEnd },
    { query: { queryKey: getListForecastQueryKey({ startDate: sixMonthStart, endDate: sixMonthEnd }) } },
  );
  // Cycle due dates trail cycle close by up to ~2 months; fetch a wider due
  // window and re-filter by cycle end below (same as Planned vs Actual).
  const sixMonthDueEnd = format(addDays(endOfMonth(addMonths(today, 5)), 70), "yyyy-MM-dd");
  const { data: sixMonthComps } = useListCardCompositions({ dueStart: sixMonthStart, dueEnd: sixMonthDueEnd });

  const ENVELOPES_KEY = SIX_MONTH_ENVELOPES_KEY;
  const { sixMonthData, chartCategories } = useMemo(() => {
    const monthKeys = Array.from({ length: 6 }, (_, i) => format(addMonths(startOfMonth(today), i), "yyyy-MM"));
    const monthIndex = new Map(monthKeys.map((k, i) => [k, i]));
    const billById = new Map((bills ?? []).map((b) => [b.id, b]));

    interface MonthAgg {
      income: number;
      byCategory: Map<string, number>;
      envelopes: number;
      forecastBillIds: Set<number>;
    }
    const months: MonthAgg[] = monthKeys.map(() => ({ income: 0, byCategory: new Map(), envelopes: 0, forecastBillIds: new Set() }));

    for (const tx of sixMonthTxs ?? []) {
      if (tx.status === "missed" || tx.isCcParent || tx.sourceBalanceSyncId) continue;
      const idx = monthIndex.get(tx.transactionDate.slice(0, 7));
      if (idx == null) continue;
      const m = months[idx]!;
      // Same sources as Planned vs Actual: pay rows for income, bill
      // occurrences for expenses. Anything else (asset-movement transfers,
      // posted card-payment actuals, one-off manual rows) is either not
      // spending or already represented by the cycle decomposition — counting
      // it here would double-count or inflate the month.
      if (tx.sourcePayId != null && tx.transactionType === "income") {
        m.income += Math.abs(tx.amount);
      } else if (tx.sourceBillId != null && tx.transactionType !== "income") {
        const cat = billById.get(tx.sourceBillId)?.category ?? "Other";
        m.byCategory.set(cat, (m.byCategory.get(cat) ?? 0) + Math.abs(tx.amount));
        m.forecastBillIds.add(tx.sourceBillId);
      }
    }

    for (const c of sixMonthComps ?? []) {
      const idx = monthIndex.get(c.cycleEnd.slice(0, 7));
      if (idx == null) continue;
      const m = months[idx]!;
      m.envelopes += foldCarryover(c.envelopes).reduce((s, e) => s + e.plannedAmount, 0);
      for (const cb of c.bills) {
        if (cb.billId == null) continue;
        // Precedence: a bill with a forecast occurrence this month is already
        // counted above — cycle rows fill in card-paid bills only.
        if (m.forecastBillIds.has(cb.billId)) continue;
        const cat = billById.get(cb.billId)?.category ?? "Other";
        m.byCategory.set(cat, (m.byCategory.get(cat) ?? 0) + cb.expectedAmount);
      }
    }

    // Categories largest-first (by 6-month total) so the biggest band renders
    // at the bottom of the stack.
    const catTotals = new Map<string, number>();
    for (const m of months) for (const [cat, amt] of m.byCategory) catTotals.set(cat, (catTotals.get(cat) ?? 0) + amt);
    const cats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const anyEnvelopes = months.some((m) => m.envelopes > 0.005);
    const chartCategories = anyEnvelopes ? [...cats, ENVELOPES_KEY] : cats;

    const sixMonthData = months.map((m, i) => {
      const row: Record<string, number | string> = { month: format(addMonths(startOfMonth(today), i), "MMM") };
      for (const cat of cats) row[cat] = m.byCategory.get(cat) ?? 0;
      if (anyEnvelopes) row[ENVELOPES_KEY] = m.envelopes;
      const expenses = [...m.byCategory.values()].reduce((s, v) => s + v, 0) + m.envelopes;
      row.income = m.income;
      row.remaining = Math.max(0, m.income - expenses);
      return row;
    });
    return { sixMonthData, chartCategories };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sixMonthTxs, sixMonthComps, bills]);

  /* ── Savings & investments ──────────────────────────────────────────── */
  // Retirement is intentionally excluded — it's shown in its own section (#R3-6).
  const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "brokerage"];
  const savingsAccounts = (accounts ?? []).filter((a) =>
    SAVINGS_INVESTMENT_TYPES.includes(a.accountType),
  );
  const savingsTotal = savingsAccounts.reduce((s, a) => s + a.currentBalance, 0);

  /* ── Next paycheck ──────────────────────────────────────────────────── */
  const todayStr = format(today, "yyyy-MM-dd");
  const nextPaycheck = (forecastTxs ?? [])
    .filter(
      (t) =>
        t.transactionType === "income" &&
        t.transactionDate >= todayStr &&
        !t.isActual &&
        !t.sourceBalanceSyncId,
    )
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))[0];
  const daysUntilPaycheck = nextPaycheck
    ? differenceInCalendarDays(new Date(nextPaycheck.transactionDate + "T00:00:00"), today)
    : null;

  /* ── Cash Flow Trend (from monthly forecast) ────────────────────────── */
  const cashFlowData = (monthlyForecast ?? []).slice(0, 6).map((m) => ({
    month: m.label,
    income: m.totalIncome,
    expenses: m.totalExpenses,
    net: m.netCashFlow,
  }));

  /* ── Connected accounts (by type) ───────────────────────────────────── */
  const accountsByType = (accounts ?? []).reduce<Record<string, number>>((acc, a) => {
    const key = a.accountType;
    const bal = a.isAsset ? a.currentBalance : -a.currentBalance;
    acc[key] = (acc[key] ?? 0) + bal;
    return acc;
  }, {});
  const maxTypeAbs = Math.max(1, ...Object.values(accountsByType).map((v) => Math.abs(v)));
  const sortedAccountTypes = Object.entries(accountsByType).sort(([, a], [, b]) => {
    const aNeg = a < 0;
    const bNeg = b < 0;
    if (aNeg && bNeg) return Math.abs(b) - Math.abs(a);
    if (aNeg) return -1;
    if (bNeg) return 1;
    return a - b;
  });

  const TYPE_LABELS: Record<string, string> = {
    checking: "Checking",
    savings: "Savings",
    investment: "Investment",
    retirement: "Retirement",
    real_estate: "Real Estate",
    loan: "Loans",
    credit_card: "Credit Card",
    mortgage: "Mortgage",
    brokerage: "Brokerage",
  };
  const typeLabel = (type: string) =>
    TYPE_LABELS[type] ??
    type
      .split(/[_\s]+/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");

  /* ── Trend estimates for Net Worth pill ─────────────────────────────── */
  const netWorth = summary?.netWorth ?? 0;
  const liabilities = summary?.totalLiabilities ?? 0;
  const prevNetWorth = netWorth - avgMonthlyCashFlow;

  // Bank-connection health: the forecast is only as good as its inputs, so a
  // failing or reauth-required connection is surfaced HERE, not just on
  // Accounts. One banner per affected institution. "Failing" requires an
  // actual failed attempt (lastSyncError) — idle-but-healthy items never show.
  const brokenConnections = (() => {
    const seen = new Map<number, { institutionName: string; needsReauth: boolean }>();
    for (const a of accounts ?? []) {
      if (a.plaidItemId == null) continue;
      if (!a.needsReauth && !a.lastSyncError) continue;
      const existing = seen.get(a.plaidItemId);
      if (!existing) {
        seen.set(a.plaidItemId, { institutionName: a.institutionName, needsReauth: a.needsReauth ?? false });
      } else if (a.needsReauth) {
        existing.needsReauth = true;
      }
    }
    return [...seen.values()];
  })();

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="tracking-tight" style={{ fontSize: 18, fontWeight: 600 }}>Dashboard</h1>
          <p className="mt-1" style={{ fontSize: 12, color: "#64748b" }}>Your financial life at a glance.</p>
        </div>
      </div>

      {brokenConnections.length > 0 && (
        <div
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 flex items-start gap-3"
          data-testid="banner-sync-failing"
        >
          <AlertTriangle className="h-4 w-4 text-red-700 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-red-800">
              {brokenConnections.map((c) => c.institutionName).join(", ")}{" "}
              {brokenConnections.length === 1 ? "isn't" : "aren't"} updating — your forecast may be using stale balances.
            </p>
            <p className="text-xs text-red-700 mt-0.5">
              {brokenConnections.some((c) => c.needsReauth)
                ? "Your bank needs you to sign in again. "
                : "We couldn't reach your bank on the last try. "}
              <Link href="/accounts" className="underline font-medium" data-testid="link-fix-connection">
                Fix it on the Accounts page
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Primary Metrics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Net Worth"
          icon={<TrendingUp className="h-4 w-4" />}
          accent="var(--color-carolina)"
          loading={isLoadingSummary}
          value={<FormatCurrency amount={netWorth} compact />}
          trend={<TrendBadge current={netWorth} previous={prevNetWorth} estimated />}
          subline={
            <span>
              <span className="text-emerald-600">
                <FormatCurrency amount={summary?.totalAssets ?? 0} compact />
              </span>
              {" assets · "}
              <span className="text-orange-600">
                <FormatCurrency amount={liabilities} compact />
              </span>
              {" debt"}
            </span>
          }
          onClick={() => setNetWorthOpen(true)}
        />

        <MetricCard
          title="Average Monthly Cash Flow"
          icon={<Wallet className="h-4 w-4" />}
          accent="#059669"
          loading={isLoadingSummary || budget.isLoading}
          value={<FormatCurrency amount={avgMonthlyCashFlow} compact showSign />}
          
          trend={<SteadyBadge />}
          subline={
            <span>
              <span className="text-emerald-600">
                <FormatCurrency amount={payMonthly} compact /> in
              </span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-orange-600">
                <FormatCurrency amount={billsMonthlyTotal} compact /> out
              </span>
            </span>
          }
          onClick={() => setCashFlowOpen(true)}
        />

        <MetricCard
          title="Savings & Investments"
          icon={<PiggyBank className="h-4 w-4" />}
          accent="#0F6E56"
          loading={isLoadingAccounts}
          value={<FormatCurrency amount={savingsTotal} compact />}
          trend={
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Minus className="h-3 w-3" />
              <span>{savingsAccounts.length} account{savingsAccounts.length === 1 ? "" : "s"}</span>
            </p>
          }
          subline={<span>Savings, investment &amp; retirement</span>}
          onClick={() => setSavingsOpen(true)}
        />

        <MetricCard
          title="Bills Snapshot"
          icon={<CalendarHeart className="h-4 w-4" />}
          accent="var(--color-navy)"
          loading={budget.isLoading}
          value={<FormatCurrency amount={avgMonthlyCashFlow} compact showSign />}
          
          trend={
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                {daysUntilPaycheck === null
                  ? "No upcoming paycheck"
                  : daysUntilPaycheck === 0
                    ? "Paycheck today"
                    : `Next paycheck in ${daysUntilPaycheck}d`}
              </span>
            </p>
          }
          subline={
            <span>
              <span className="text-emerald-600">
                <FormatCurrency amount={payMonthly} compact />
              </span>
              {" in / "}
              <span className="text-orange-600">
                <FormatCurrency amount={billsMonthlyTotal} compact />
              </span>
              {" out"}
            </span>
          }
          onClick={() => setBillsSnapshotOpen(true)}
        />
      </div>

      {/* Row 2: 6 Month View + Retirement Progress */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 6 Month View */}
        <Card className={`${cardChrome} col-span-1 lg:col-span-2`}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold tracking-tight">6 Month View</CardTitle>
                <CardDescription>How your income covers your bills</CardDescription>
              </div>
              <Link
                href="/bills"
                className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
              >
                View budget <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingBills ? (
              <Skeleton className="h-[280px] w-full" />
            ) : payMonthly === 0 && chartCategories.length === 0 ? (
              <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
                Add pay and bills to see your 6 month view.
              </div>
            ) : (
              <>
                <div className="h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sixMonthData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                      <XAxis
                        dataKey="month"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 12 }}
                        className="text-muted-foreground"
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v: number) => fmt(v)}
                        width={64}
                        className="text-muted-foreground"
                      />
                      <Tooltip
                        content={(props) => (
                          <SixMonthTooltip {...(props as any)} categories={chartCategories} />
                        )}
                      />
                      {chartCategories.map((cat) => (
                        <Area
                          key={cat}
                          type="monotone"
                          dataKey={cat}
                          stackId="1"
                          stroke={softenColor(sixMonthSeriesColor(cat))}
                          fill={softenColor(sixMonthSeriesColor(cat))}
                          fillOpacity={0.65}
                        />
                      ))}
                      <Area
                        type="monotone"
                        dataKey="remaining"
                        stackId="1"
                        stroke={softenColor("#059669")}
                        fill={softenColor("#059669")}
                        fillOpacity={0.65}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                {/* Legend */}
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                  {chartCategories.map((cat) => (
                    <span key={cat} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span
                        className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: softenColor(sixMonthSeriesColor(cat)) }}
                      />
                      {sixMonthSeriesLabel(cat)}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: softenColor("#059669") }} />
                    Cash flow
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Retirement Progress */}
        <Card className={cardChrome}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold tracking-tight">Retirement Progress</CardTitle>
                <CardDescription>Progress toward your goal</CardDescription>
              </div>
              <Link
                href="/retirement"
                className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
              >
                View plan <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingRetirement ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-40" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : retirementSummary ? (
              <div className="space-y-6">
                <div>
                  <div className="text-3xl font-bold font-mono tabular-nums">
                    <FormatCurrency amount={retirementSummary.currentSavings} />
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">Current Balance</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-primary">{Math.round(retirementSummary.readinessScore)}% Funded</span>
                    <span className="text-muted-foreground">
                      Goal: <FormatCurrency amount={(retirementSummary.retirementGoal ?? 0)} compact />
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${Math.min(100, retirementSummary.readinessScore)}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Projected</p>
                    <p className="text-lg font-medium font-mono tabular-nums mt-0.5 text-foreground">
                      <FormatCurrency amount={retirementSummary.projectedValue} compact />
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Monthly Contrib</p>
                    <p className="text-lg font-medium font-mono tabular-nums mt-0.5 text-foreground">
                      <FormatCurrency amount={retirementSummary.monthlyContribution} />
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-6 flex items-center justify-center text-muted-foreground text-sm">
                No retirement plan set up.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Cash Flow Trend + Accounts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cash Flow Trend */}
        <Card className={cardChrome}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold tracking-tight">Cash Flow Trend</CardTitle>
                <CardDescription>Income vs. expenses</CardDescription>
              </div>
              <Link
                href="/forecast"
                className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
              >
                View ledger <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingForecast ? (
              <Skeleton className="h-[240px] w-full" />
            ) : cashFlowData.length > 0 ? (
              <div className="h-[240px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={cashFlowData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                    <XAxis
                      dataKey="month"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 12 }}
                      className="text-muted-foreground"
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 12 }}
                      tickFormatter={(v: number) => fmt(v)}
                      width={64}
                      className="text-muted-foreground"
                    />
                    <Tooltip
                      formatter={(v: number, name: string) => [fmt(v), name]}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Bar dataKey="income" name="Income" fill={softenColor("#059669")} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="expenses" name="Expenses" fill={softenColor("#dc2626")} radius={[3, 3, 0, 0]} />
                    <Area
                      type="monotone"
                      dataKey="net"
                      name="Net"
                      stroke="var(--color-navy)"
                      fill="var(--color-navy)"
                      fillOpacity={0.1}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="py-16 flex items-center justify-center text-muted-foreground text-sm">
                No forecast data yet.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Accounts */}
        <Card className={cardChrome}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold tracking-tight">Accounts</CardTitle>
              <Link
                href="/accounts"
                className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
              >
                All accounts <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <CardDescription>By account type</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingAccounts ? (
              <div className="space-y-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="flex justify-between items-center">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            ) : sortedAccountTypes.length > 0 ? (
              <div className="space-y-3">
                {sortedAccountTypes.map(([type, bal]) => {
                  const meta = accountTypeMeta(type);
                  const Icon = meta?.icon;
                  const color = meta?.color ?? "#888780";
                  const width = `${Math.max(4, Math.round((Math.abs(bal) / maxTypeAbs) * 100))}%`;
                  return (
                    <div key={type}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {Icon && <Icon className="h-4 w-4 shrink-0" style={{ color }} strokeWidth={1.5} />}
                          {typeLabel(type)}
                        </span>
                        <span
                          className={`text-sm font-mono tabular-nums font-medium ${
                            bal < 0 ? "text-destructive" : ""
                          }`}
                        >
                          <FormatCurrency amount={bal} />
                        </span>
                      </div>
                      <span className="block h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <span
                          className="block h-full rounded-full"
                          style={{ width, backgroundColor: bal < 0 ? "#dc2626" : color }}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-6 flex items-center justify-center text-muted-foreground text-sm">
                No accounts connected.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <NetWorthModal
        open={netWorthOpen}
        onOpenChange={setNetWorthOpen}
        accounts={accounts ?? []}
        assets={assets ?? []}
        loans={loans ?? []}
      />
      <CashFlowModal open={cashFlowOpen} onOpenChange={setCashFlowOpen} />
      <SavingsInvestmentsModal
        open={savingsOpen}
        onOpenChange={setSavingsOpen}
        accounts={accounts ?? []}
      />
      <BillsSnapshotModal
        open={billsSnapshotOpen}
        onOpenChange={setBillsSnapshotOpen}
        takeHomePay={budget.monthlyIncome}
        totalBills={budget.totalBills}
        netCashFlow={budget.netCashFlow}
        daysUntilPaycheck={daysUntilPaycheck}
      />
    </div>
  );
}
