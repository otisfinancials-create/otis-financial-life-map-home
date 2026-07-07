import {
  useGetDashboardSummary,
  useGetUpcomingBills,
  useListAccounts,
  useGetMonthlyForecast,
  useListBills,
  useListForecast,
  useListLifeEvents,
} from "@workspace/api-client-react";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { monthlyFactor } from "@/lib/bill-math";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Banknote,
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  ExternalLink,
  CalendarHeart,
} from "lucide-react";
import {
  ComposedChart,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { format, startOfMonth, addDays, differenceInCalendarDays } from "date-fns";
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
      title="This figure comes from your recurring bills and pay schedules, so it stays steady month to month unless you change them."
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
      style={{
        borderLeft: `3px solid ${accent}`,
        backgroundImage: `linear-gradient(135deg, ${accent}0d 0%, transparent 55%)`,
      }}
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
            <div className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${valueClass}`}>
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

/* ── Dashboard ────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: upcomingBills, isLoading: isLoadingBills } = useGetUpcomingBills();
  const { data: lifeEvents, isLoading: isLoadingLifeEvents } = useListLifeEvents();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: monthlyForecast, isLoading: isLoadingForecast } = useGetMonthlyForecast();
  const { data: bills } = useListBills();

  const today = new Date();
  const monthStartStr = format(startOfMonth(today), "yyyy-MM-dd");
  const snapshotEndStr = format(addDays(today, 60), "yyyy-MM-dd");
  const { data: forecastTxs, isLoading: isLoadingTxs } = useListForecast({
    startDate: monthStartStr,
    endDate: snapshotEndStr,
  });

  /* Chart data.
     Life-event costs are part of totalExpenses (so netCashFlow stays correct),
     so we break them out and show regular expenses = total − life events. The
     two stack together to equal total spending. */
  const cashFlowData = (monthlyForecast ?? []).slice(0, 6).map((m) => ({
    month: m.label,
    income: m.totalIncome,
    expenses: Math.max(0, m.totalExpenses - m.totalLifeEvents),
    lifeEvents: m.totalLifeEvents,
    net: m.netCashFlow,
  }));
  const hasLifeEvents = cashFlowData.some((m) => m.lifeEvents > 0);

  /* Upcoming life events: soonest by date, active only, in the future. */
  const todayIso = format(today, "yyyy-MM-dd");
  const upcomingLifeEvents = (lifeEvents ?? [])
    .filter((e) => e.isActive)
    .map((e) => ({ event: e, date: e.eventDate || e.startDate || "" }))
    .filter((x) => x.date && x.date >= todayIso)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  const avgIncome =
    cashFlowData.length > 0
      ? cashFlowData.reduce((s, m) => s + m.income, 0) / cashFlowData.length
      : 0;

  /* Trend estimates.
     No historical snapshots exist, so net worth / liabilities changes are
     estimated from monthly cash flow and debt payments (labeled "est.").
     Income and cash flow are recurring (bills + pay schedules), so their
     month-over-month change is flat unless the user edits them. */
  const netWorth = summary?.netWorth ?? 0;
  const cashFlow = summary?.monthlyCashFlow ?? 0;
  const liabilities = summary?.totalLiabilities ?? 0;
  const monthlyDebtPayments = (bills ?? [])
    .filter((b) => b.isActive && b.category === "Debt Payments")
    .reduce((s, b) => s + b.amount * monthlyFactor(b.frequency), 0);

  const prevNetWorth = netWorth - cashFlow;
  const prevLiabilities = liabilities + monthlyDebtPayments;

  /* Monthly snapshot */
  const monthKey = format(today, "yyyy-MM");
  const todayStr = format(today, "yyyy-MM-dd");
  const monthTxs = (forecastTxs ?? []).filter((t) => t.transactionDate.startsWith(monthKey));
  const billsPaidThisMonth = monthTxs.filter(
    (t) => t.transactionType === "expense" && t.isActual
  ).length;
  const billsRemainingThisMonth = monthTxs.filter(
    (t) => t.transactionType === "expense" && !t.isActual
  ).length;
  const nextPaycheck = (forecastTxs ?? [])
    .filter((t) => t.transactionType === "income" && t.transactionDate >= todayStr)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))[0];
  const daysUntilPaycheck = nextPaycheck
    ? differenceInCalendarDays(new Date(nextPaycheck.transactionDate + "T00:00:00"), today)
    : null;

  /* Accounts by type */
  const accountsByType = (accounts ?? []).reduce<Record<string, number>>((acc, a) => {
    const key = a.accountType;
    const bal = a.isAsset ? a.currentBalance : -a.currentBalance;
    acc[key] = (acc[key] ?? 0) + bal;
    return acc;
  }, {});
  const maxTypeAbs = Math.max(1, ...Object.values(accountsByType).map((v) => Math.abs(v)));

  const TYPE_LABELS: Record<string, string> = {
    checking: "Checking",
    savings: "Savings",
    investment: "Investment",
    retirement: "Retirement",
    real_estate: "Real Estate",
    loan: "Loans",
    credit_card: "Credit Card",
    mortgage: "Mortgage",
  };
  const typeLabel = (type: string) =>
    TYPE_LABELS[type] ??
    type
      .split(/[_\s]+/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");

  const urgencyColor = (days: number) =>
    days <= 3 ? "#ef4444" : days <= 7 ? "#f97316" : "#9ca3af";
  const urgencyFill = (days: number) =>
    `${Math.max(8, Math.round(((30 - Math.min(days, 30)) / 30) * 100))}%`;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Your financial life at a glance.</p>
        </div>
      </div>

      {/* Primary Metrics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Net Worth"
          icon={<TrendingUp className="h-4 w-4" />}
          accent="#3b82f6"
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
          onClick={() => navigate("/accounts")}
        />

        <MetricCard
          title="Monthly Cash Flow"
          icon={<Wallet className="h-4 w-4" />}
          accent="#22c55e"
          loading={isLoadingSummary}
          value={<FormatCurrency amount={cashFlow} compact showSign />}
          valueClass={cashFlow >= 0 ? "text-emerald-600" : "text-destructive"}
          trend={<SteadyBadge />}
          subline={
            <span>
              <span className="text-emerald-600">
                <FormatCurrency amount={summary?.monthlyIncome ?? 0} compact /> in
              </span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-orange-600">
                <FormatCurrency amount={summary?.monthlyExpenses ?? 0} compact /> out
              </span>
            </span>
          }
          onClick={() => navigate("/forecast")}
        />

        <MetricCard
          title="Monthly Income"
          icon={<Banknote className="h-4 w-4" />}
          accent="#14b8a6"
          loading={isLoadingSummary}
          value={<FormatCurrency amount={summary?.monthlyIncome ?? 0} compact />}
          valueClass="text-teal-700"
          trend={<SteadyBadge />}
          subline={<span>from pay schedules</span>}
          onClick={() => navigate("/pay-schedules")}
        />

        <MetricCard
          title="Total Liabilities"
          icon={<AlertCircle className="h-4 w-4" />}
          accent="#f97316"
          loading={isLoadingSummary}
          value={<FormatCurrency amount={liabilities} compact />}
          trend={
            <TrendBadge
              current={liabilities}
              previous={monthlyDebtPayments > 0 ? prevLiabilities : null}
              positiveIsGood={false}
              estimated
            />
          }
          subline={
            <span>
              <span className="text-emerald-600">
                <FormatCurrency amount={summary?.totalAssets ?? 0} compact />
              </span>
              {" total assets"}
            </span>
          }
          onClick={() => navigate("/accounts")}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column: chart + monthly snapshot */}
        <div className="col-span-1 lg:col-span-2 flex flex-col gap-6">
          <Card className={cardChrome}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg font-semibold tracking-tight">Cash Flow Trend</CardTitle>
                  <CardDescription>
                    {cashFlowData.length > 0
                      ? `${cashFlowData[0]?.month} – ${cashFlowData[cashFlowData.length - 1]?.month} · income vs expenses`
                      : "Income vs expenses · next 6 months"}
                  </CardDescription>
                </div>
                {cashFlowData.length > 0 && (
                  <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1 shrink-0">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-sm bg-emerald-500" />
                      Income
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-sm bg-orange-500" />
                      Expenses
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 border-t border-dashed border-muted-foreground" />
                      Avg income
                    </span>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingForecast ? (
                <Skeleton className="h-[280px] w-full" />
              ) : cashFlowData.length > 0 ? (
                <div className="h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={cashFlowData}
                      margin={{ top: 10, right: 0, left: -20, bottom: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="hsl(var(--border))"
                      />
                      <XAxis
                        dataKey="month"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        dy={10}
                      />
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        tickFormatter={(v) => `$${v / 1000}k`}
                      />
                      <Tooltip
                        cursor={{ fill: "hsl(var(--muted)/0.3)" }}
                        contentStyle={{
                          backgroundColor: "hsl(var(--popover))",
                          borderColor: "hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        itemStyle={{ color: "hsl(var(--foreground))" }}
                        formatter={(value: number, name: string) => [
                          fmt(value),
                          name === "income"
                            ? "Income"
                            : name === "expenses"
                              ? "Expenses"
                              : name === "lifeEvents"
                                ? "Life Events"
                                : "Net",
                        ]}
                      />
                      <Area
                        dataKey="income"
                        type="monotone"
                        fill="#22c55e"
                        fillOpacity={0.12}
                        stroke="none"
                        legendType="none"
                        tooltipType="none"
                        activeDot={false}
                      />
                      <ReferenceLine
                        y={avgIncome}
                        stroke="hsl(var(--muted-foreground))"
                        strokeWidth={1}
                        strokeDasharray="4 4"
                      />
                      <Bar
                        dataKey="income"
                        name="income"
                        fill="#22c55e"
                        radius={[5, 5, 0, 0]}
                        maxBarSize={36}
                      />
                      <Bar
                        dataKey="expenses"
                        name="expenses"
                        stackId="spending"
                        fill="#f97316"
                        radius={hasLifeEvents ? [0, 0, 0, 0] : [5, 5, 0, 0]}
                        maxBarSize={36}
                      />
                      {hasLifeEvents && (
                        <Bar
                          dataKey="lifeEvents"
                          name="lifeEvents"
                          stackId="spending"
                          fill="#14b8a6"
                          radius={[5, 5, 0, 0]}
                          maxBarSize={36}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[280px] flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  <p className="text-sm">No forecast data yet.</p>
                  <Link href="/forecast" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                    Go to Forecast to generate it <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Monthly Snapshot */}
          <Card className={cardChrome}>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold tracking-tight">Monthly Snapshot</CardTitle>
              <CardDescription>{format(today, "MMMM yyyy")}</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingTxs ? (
                <div className="grid grid-cols-3 gap-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-3 divide-x divide-border">
                  <div className="px-2 text-center">
                    <p className="text-3xl font-bold font-mono tabular-nums text-emerald-600">
                      {billsPaidThisMonth}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5 uppercase tracking-wider font-medium">
                      Bills Paid This Month
                    </p>
                  </div>
                  <div className="px-2 text-center">
                    <p className="text-3xl font-bold font-mono tabular-nums text-emerald-600">
                      {billsRemainingThisMonth}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5 uppercase tracking-wider font-medium">
                      Bills Remaining This Month
                    </p>
                  </div>
                  <div className="px-2 text-center">
                    <p className="text-3xl font-bold font-mono tabular-nums text-emerald-600">
                      {daysUntilPaycheck === null
                        ? "—"
                        : daysUntilPaycheck === 0
                          ? "Today"
                          : daysUntilPaycheck}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1.5 uppercase tracking-wider font-medium">
                      Days Until Next Paycheck
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: Upcoming Bills + Account Breakdown */}
        <div className="flex flex-col gap-6">
          {/* Upcoming Bills */}
          <Card className={`${cardChrome} flex-1`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold tracking-tight">Upcoming Bills</CardTitle>
                <Link
                  href="/bills"
                  className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
                >
                  All bills <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <CardDescription>Next 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingBills ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex justify-between items-center">
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-24" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                      <Skeleton className="h-3.5 w-14" />
                    </div>
                  ))}
                </div>
              ) : upcomingBills?.length ? (
                <div className="space-y-1">
                  {upcomingBills.slice(0, 6).map((bill) => (
                    // Intentionally div+onClick (not <Link>) — the card header already
                    // contains a <Link href="/bills"> ("All bills"), so using <Link>
                    // here would create <a> nested inside <a>, triggering a React
                    // hydration warning. Navigation via onClick keeps the rows clickable
                    // without invalid HTML nesting.
                    <div
                      key={bill.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate("/bills")}
                      onKeyDown={(e) => e.key === "Enter" && navigate("/bills")}
                      className="flex items-start justify-between gap-3 rounded-md cursor-pointer hover:bg-muted/40 transition-colors py-2 px-1.5 -mx-1.5"
                    >
                      <span
                        className="h-2 w-2 rounded-full shrink-0 mt-1.5"
                        style={{ backgroundColor: urgencyColor(bill.daysUntilDue) }}
                        title={`${bill.category} — due in ${bill.daysUntilDue}d`}
                      />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-medium truncate">{bill.billName}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          {bill.daysUntilDue === 0 ? (
                            <span className="text-destructive font-medium">Due today</span>
                          ) : bill.daysUntilDue === 1 ? (
                            <span className="text-orange-600 font-medium">Due tomorrow</span>
                          ) : (
                            <span className={bill.daysUntilDue <= 7 ? "text-orange-600" : ""}>
                              Due in {bill.daysUntilDue}d
                            </span>
                          )}
                          <span className="opacity-40">·</span>
                          <span>{format(new Date(bill.dueDate + "T00:00:00"), "MMM d")}</span>
                        </span>
                        <span className="mt-1.5 block h-1 w-full max-w-[120px] rounded-full bg-muted overflow-hidden">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: urgencyFill(bill.daysUntilDue),
                              backgroundColor: urgencyColor(bill.daysUntilDue),
                            }}
                          />
                        </span>
                      </div>
                      <span className="text-sm font-mono tabular-nums font-medium shrink-0">
                        <FormatCurrency amount={bill.amount} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 flex items-center justify-center text-muted-foreground text-sm">
                  No bills due soon.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Upcoming Life Events */}
          <Card className={cardChrome}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold tracking-tight">Upcoming Life Events</CardTitle>
                <Link
                  href="/life-events"
                  className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
                >
                  All events <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <CardDescription>Your next milestones</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoadingLifeEvents ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex justify-between items-center">
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                      <Skeleton className="h-3.5 w-14" />
                    </div>
                  ))}
                </div>
              ) : upcomingLifeEvents.length ? (
                <div className="space-y-1">
                  {upcomingLifeEvents.map(({ event, date }) => (
                    <div
                      key={event.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate("/life-events")}
                      onKeyDown={(e) => e.key === "Enter" && navigate("/life-events")}
                      className="flex items-start justify-between gap-3 rounded-md cursor-pointer hover:bg-muted/40 transition-colors py-2 px-1.5 -mx-1.5"
                    >
                      <span className="h-2 w-2 rounded-full shrink-0 mt-1.5" style={{ backgroundColor: "#14b8a6" }} />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-medium truncate">{event.eventName}</span>
                        <span className="text-xs text-muted-foreground mt-0.5">
                          {format(new Date(date + "T00:00:00"), "MMM d, yyyy")}
                        </span>
                      </div>
                      <span className="text-sm font-mono tabular-nums font-medium shrink-0">
                        <FormatCurrency amount={event.amount} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
                  <CalendarHeart className="h-5 w-5" />
                  <span>No upcoming life events.</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Net Worth breakdown by account type */}
          <Card className={cardChrome}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold tracking-tight">By Account Type</CardTitle>
                <Link
                  href="/accounts"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  All accounts <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingAccounts ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex justify-between items-center">
                      <Skeleton className="h-3.5 w-20" />
                      <Skeleton className="h-3.5 w-16" />
                    </div>
                  ))}
                </div>
              ) : Object.keys(accountsByType).length > 0 ? (
                <div className="space-y-3.5">
                  {Object.entries(accountsByType).map(([type, total]) => (
                    <div key={type}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-muted-foreground">
                          {typeLabel(type)}
                        </span>
                        <span
                          className={`text-sm font-mono tabular-nums font-medium ${
                            total >= 0 ? "text-foreground" : "text-orange-600"
                          }`}
                        >
                          {total < 0 ? "−" : ""}
                          {fmt(Math.abs(total))}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.max(3, Math.round((Math.abs(total) / maxTypeAbs) * 100))}%`,
                            backgroundColor: total >= 0 ? "#22c55e" : "#f97316",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No accounts yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
