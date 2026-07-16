import {
  useGetDashboardSummary,
  useGetUpcomingBills,
  useListAccounts,
  useGetMonthlyForecast,
  useListBills,
  useListForecast,
  useListLifeEvents,
  useListLoans,
  useListAssets,
  useListPaySchedules,
  useGetRetirementSummary,
  useGetUserSettings,
} from "@workspace/api-client-react";
import {
  NetWorthModal,
  CashFlowModal,
  LiabilitiesModal,
} from "@/components/dashboard/breakdown-modals";
import { useState } from "react";
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
import { accountTypeMeta, ICON_STROKE, getCategoryEmoji } from "@/utils/categoryIcons";
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

// #4: Upcoming Bills rows deep-link to the Forecast ledger. UpcomingBill has no
// forecasted-transaction id, so we pass date + description for the Forecast page
// to locate and flash the matching row.
function billForecastHref(bill: { dueDate: string; billName: string }): string {
  const params = new URLSearchParams({
    txdate: bill.dueDate,
    txdesc: bill.billName,
  });
  return `/forecast?${params.toString()}`;
}

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
  const { data: loans } = useListLoans();
  const { data: assets } = useListAssets();
  const { data: paySchedules } = useListPaySchedules();
  const { data: retirementSummary, isLoading: isLoadingRetirement } = useGetRetirementSummary();

  const [netWorthOpen, setNetWorthOpen] = useState(false);
  const [cashFlowOpen, setCashFlowOpen] = useState(false);
  const [liabilitiesOpen, setLiabilitiesOpen] = useState(false);

  const today = new Date();
  const monthStartStr = format(startOfMonth(today), "yyyy-MM-dd");
  const snapshotEndStr = format(addDays(today, 60), "yyyy-MM-dd");
  const { data: forecastTxs, isLoading: isLoadingTxs } = useListForecast({
    startDate: monthStartStr,
    endDate: snapshotEndStr,
  });
  const { data: userSettings } = useGetUserSettings();

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
    .filter(
      (t) =>
        t.transactionType === "income" &&
        t.transactionDate >= todayStr &&
        !t.isActual &&
        !t.sourceBalanceSyncId
    )
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))[0];
  const daysUntilPaycheck = nextPaycheck
    ? differenceInCalendarDays(new Date(nextPaycheck.transactionDate + "T00:00:00"), today)
    : null;

  /* Upcoming forecast rows with running balance (simplified version of the
     forecast page anchor algorithm: latest balance-override row ≤ today wins,
     otherwise start from settings starting balance minus past net). */
  const startingBalance = userSettings?.startingBalance ?? 0;
  const sortedTxs = [...(forecastTxs ?? [])].sort(
    (a, b) =>
      a.transactionDate.localeCompare(b.transactionDate) ||
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      a.id - b.id
  );
  const isOverride = (t: (typeof sortedTxs)[number]) => t.sourceBalanceSyncId != null;
  const signedAmt = (t: (typeof sortedTxs)[number]) =>
    t.status === "missed" ? 0 : t.transactionType === "income" ? t.amount : -t.amount;
  let anchorIdx = -1;
  for (let i = 0; i < sortedTxs.length; i++) {
    if (isOverride(sortedTxs[i]) && sortedTxs[i].transactionDate <= todayStr) anchorIdx = i;
  }
  const balances: number[] = new Array(sortedTxs.length).fill(0);
  if (anchorIdx >= 0) {
    let run = sortedTxs[anchorIdx].amount;
    balances[anchorIdx] = run;
    for (let i = anchorIdx + 1; i < sortedTxs.length; i++) {
      run = isOverride(sortedTxs[i]) ? sortedTxs[i].amount : run + signedAmt(sortedTxs[i]);
      balances[i] = run;
    }
  } else {
    // No override anchor: starting balance is as-of today, so rewind past net first.
    const pastNet = sortedTxs
      .filter((t) => t.transactionDate < todayStr && !isOverride(t))
      .reduce((s, t) => s + signedAmt(t), 0);
    let run = startingBalance - pastNet;
    for (let i = 0; i < sortedTxs.length; i++) {
      run = isOverride(sortedTxs[i]) ? sortedTxs[i].amount : run + signedAmt(sortedTxs[i]);
      balances[i] = run;
    }
  }
  const upcomingRows = sortedTxs
    .map((tx, i) => ({ tx, balance: balances[i] }))
    .filter(({ tx }) => tx.transactionDate >= todayStr && !isOverride(tx))
    .slice(0, 8);

  /* Accounts by type */
  const accountsByType = (accounts ?? []).reduce<Record<string, number>>((acc, a) => {
    const key = a.accountType;
    const bal = a.isAsset ? a.currentBalance : -a.currentBalance;
    acc[key] = (acc[key] ?? 0) + bal;
    return acc;
  }, {});
  const maxTypeAbs = Math.max(1, ...Object.values(accountsByType).map((v) => Math.abs(v)));
  // #17: negative-balance types first (by absolute value, highest first),
  // then positive types low → high.
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
  };
  const typeLabel = (type: string) =>
    TYPE_LABELS[type] ??
    type
      .split(/[_\s]+/)
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ");

  const urgencyColor = (days: number) =>
    days <= 3 ? "#ef4444" : days <= 7 ? "#d97706" : "#9ca3af";
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
          title="Monthly Cash Flow"
          icon={<Wallet className="h-4 w-4" />}
          accent="#059669"
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
          onClick={() => setCashFlowOpen(true)}
        />

        <MetricCard
          title="Total Liabilities"
          icon={<AlertCircle className="h-4 w-4" />}
          accent="#d97706"
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
          onClick={() => setLiabilitiesOpen(true)}
        />

        <MetricCard
          title="Bills This Month"
          icon={<CalendarHeart className="h-4 w-4" />}
          accent="var(--color-navy)"
          loading={isLoadingTxs}
          value={billsPaidThisMonth + billsRemainingThisMonth}
          trend={
            <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <span>{billsPaidThisMonth} paid</span>
            </p>
          }
          subline={
            <span>
              <span className="text-orange-600">{billsRemainingThisMonth}</span>
              {" remaining"}
            </span>
          }
          onClick={() => navigate("/bills")}
        />
      </div>

      {/* Row 2 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Upcoming Forecast */}
        <div className="col-span-1 lg:col-span-2 flex flex-col gap-6">
          <Card className={`${cardChrome} flex-1`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg font-semibold tracking-tight">Upcoming Forecast</CardTitle>
                  <CardDescription>Next 8 transactions</CardDescription>
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
              {isLoadingTxs ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <div key={i} className="flex justify-between items-center">
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                      <Skeleton className="h-4 w-16" />
                    </div>
                  ))}
                </div>
              ) : upcomingRows.length > 0 ? (
                <div className="space-y-0.5 divide-y divide-border">
                  {upcomingRows.map(({ tx, balance }) => {
                    const isToday = tx.transactionDate === todayStr;
                    return (
                      <div
                        key={tx.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/forecast?txdate=${tx.transactionDate}&txdesc=${tx.description}`)}
                        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2.5 px-2 -mx-2 cursor-pointer hover:bg-muted/40 transition-colors rounded-md ${
                          isToday ? "border-l-4 border-l-amber-500 bg-amber-500/5" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="text-xs text-muted-foreground w-12 shrink-0">
                            {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d")}
                          </div>
                          <div>
                            <div className="text-sm font-medium flex items-center gap-1.5">
                              {isToday && <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600">TODAY</span>}
                              {tx.description}
                            </div>
                            <div className="text-xs text-muted-foreground capitalize">
                              {tx.transactionType}
                            </div>
                          </div>
                        </div>
                        <div className="flex sm:flex-col items-center sm:items-end gap-3 sm:gap-0.5 justify-between">
                          <div className={`text-sm font-mono tabular-nums font-medium ${tx.transactionType === "income" ? "text-emerald-600" : ""}`}>
                            {tx.transactionType === "expense" ? "−" : "+"}<FormatCurrency amount={tx.amount} />
                          </div>
                          <div className={`text-xs font-mono tabular-nums ${balance < 0 ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                            {isToday ? "Bal: " : ""}<FormatCurrency amount={balance} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-6 flex items-center justify-center text-muted-foreground text-sm">
                  No upcoming transactions.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Bills Due Soon */}
        <div className="flex flex-col gap-6">
          <Card className={`${cardChrome} flex-1`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg font-semibold tracking-tight">Bills Due Soon</CardTitle>
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
                  {upcomingBills.slice(0, 4).map((bill) => (
                    <div
                      key={bill.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(billForecastHref(bill))}
                      onKeyDown={(e) => e.key === "Enter" && navigate(billForecastHref(bill))}
                      className="flex items-start justify-between gap-3 rounded-md cursor-pointer hover:bg-muted/40 transition-colors py-2 px-1.5 -mx-1.5"
                    >
                      <span
                        className="h-2 w-2 rounded-full shrink-0 mt-1.5"
                        style={{ backgroundColor: urgencyColor(bill.daysUntilDue) }}
                        title={`${bill.category} — due in ${bill.daysUntilDue}d`}
                      />
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-sm font-medium truncate flex items-center gap-1.5">
                          <span
                            className="shrink-0"
                            style={{ fontSize: "16px", lineHeight: 1 }}
                            aria-label={bill.category}
                          >
                            {getCategoryEmoji(bill.category, bill.billName)}
                          </span>
                          <span className="truncate">{bill.billName}</span>
                        </span>
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
        </div>
      </div>

      {/* Row 3 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Monthly Snapshot */}
        <Card className={cardChrome}>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg font-semibold tracking-tight">Monthly Snapshot</CardTitle>
            <CardDescription>{format(today, "MMMM yyyy")}</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingTxs || isLoadingBills ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600">
                    {billsPaidThisMonth}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
                    Bills Paid
                  </p>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-2xl font-bold font-mono tabular-nums text-orange-600">
                    {billsRemainingThisMonth}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
                    Bills Remaining
                  </p>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-2xl font-bold font-mono tabular-nums text-primary">
                    {daysUntilPaycheck === null
                      ? "—"
                      : daysUntilPaycheck === 0
                        ? "Today"
                        : daysUntilPaycheck}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
                    Days To Paycheck
                  </p>
                </div>
                <div className="rounded-lg border border-border p-4 text-center">
                  <p className="text-2xl font-bold font-mono tabular-nums text-destructive">
                    {upcomingBills?.filter(b => b.daysUntilDue <= 3).length ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-medium">
                    Critical Bills
                  </p>
                </div>
              </div>
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

      <NetWorthModal
        open={netWorthOpen}
        onOpenChange={setNetWorthOpen}
        accounts={accounts ?? []}
        assets={assets ?? []}
        loans={loans ?? []}
      />
      <CashFlowModal
        open={cashFlowOpen}
        onOpenChange={setCashFlowOpen}
        paySchedules={paySchedules ?? []}
        bills={bills ?? []}
      />
      <LiabilitiesModal
        open={liabilitiesOpen}
        onOpenChange={setLiabilitiesOpen}
        accounts={accounts ?? []}
        loans={loans ?? []}
      />
    </div>
  );
}
