import {
  useGetDashboardSummary,
  useGetUpcomingBills,
  useListAccounts,
  useGetMonthlyForecast,
} from "@workspace/api-client-react";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowUpRight,
  Wallet,
  TrendingUp,
  AlertCircle,
  Banknote,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { format } from "date-fns";
import { Link, useLocation } from "wouter";

const fmt = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(v);

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: upcomingBills, isLoading: isLoadingBills } = useGetUpcomingBills();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: monthlyForecast, isLoading: isLoadingForecast } = useGetMonthlyForecast();

  // Use first 6 months of real forecast data for the chart
  const cashFlowData = (monthlyForecast ?? []).slice(0, 6).map((m) => ({
    month: m.label,
    income: m.totalIncome,
    expenses: m.totalExpenses,
    net: m.netCashFlow,
  }));

  // Group accounts by type for the sidebar breakdown
  const accountsByType = (accounts ?? []).reduce<Record<string, number>>((acc, a) => {
    const key = a.accountType;
    const bal = a.isAsset ? a.currentBalance : -a.currentBalance;
    acc[key] = (acc[key] ?? 0) + bal;
    return acc;
  }, {});

  const TYPE_LABELS: Record<string, string> = {
    checking: "Checking",
    savings: "Savings",
    investment: "Investment",
    retirement: "Retirement",
    real_estate: "Real Estate",
    loan: "Loans",
  };

  const metricCardClass =
    "bg-card border-border cursor-pointer transition-all duration-150 hover:border-primary/50 hover:bg-card/80 group";

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Your financial life at a glance.</p>
        </div>
      </div>

      {/* Primary Metrics — all clickable */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">

        {/* Net Worth → Accounts */}
        <Card className={metricCardClass} onClick={() => navigate("/accounts")}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Worth</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  <FormatCurrency amount={summary?.netWorth ?? 0} compact />
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center justify-between">
                  <span>
                    <span className="text-chart-2 inline-flex items-center gap-0.5">
                      <ArrowUpRight className="h-3 w-3" />
                      <FormatCurrency amount={summary?.totalAssets ?? 0} compact />
                    </span>
                    {" assets · "}
                    <span className="text-chart-3">
                      <FormatCurrency amount={summary?.totalLiabilities ?? 0} compact />
                    </span>
                    {" debt"}
                  </span>
                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Monthly Cash Flow → Forecast */}
        <Card className={metricCardClass} onClick={() => navigate("/forecast")}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Cash Flow</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div
                  className={`text-2xl font-bold font-mono tracking-tight ${
                    (summary?.monthlyCashFlow ?? 0) >= 0 ? "text-chart-2" : "text-destructive"
                  }`}
                >
                  <FormatCurrency amount={summary?.monthlyCashFlow ?? 0} compact showSign />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-chart-2">
                      <FormatCurrency amount={summary?.monthlyIncome ?? 0} compact /> in
                    </span>
                    <span className="text-muted-foreground">/</span>
                    <span className="text-chart-3">
                      <FormatCurrency amount={summary?.monthlyExpenses ?? 0} compact /> out
                    </span>
                  </div>
                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Monthly Income → Pay Schedules */}
        <Card className={metricCardClass} onClick={() => navigate("/pay-schedules")}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Income</CardTitle>
            <Banknote className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div className="text-2xl font-bold font-mono tracking-tight text-chart-2">
                  <FormatCurrency amount={summary?.monthlyIncome ?? 0} compact />
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center justify-between">
                  <span>from pay schedules</span>
                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Total Liabilities → Accounts */}
        <Card className={metricCardClass} onClick={() => navigate("/accounts")}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Liabilities</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  <FormatCurrency amount={summary?.totalLiabilities ?? 0} compact />
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center justify-between">
                  <span>
                    <span className="text-chart-2">
                      <FormatCurrency amount={summary?.totalAssets ?? 0} compact />
                    </span>
                    {" total assets"}
                  </span>
                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Cash Flow Chart — real forecast data */}
        <Card className="col-span-1 lg:col-span-2 bg-card border-border">
          <CardHeader>
            <CardTitle>Cash Flow Trend</CardTitle>
            <CardDescription>
              {cashFlowData.length > 0
                ? `${cashFlowData[0]?.month} – ${cashFlowData[cashFlowData.length - 1]?.month} · income vs expenses`
                : "Income vs expenses · next 6 months"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingForecast ? (
              <Skeleton className="h-[280px] w-full" />
            ) : cashFlowData.length > 0 ? (
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
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
                        name === "income" ? "Income" : name === "expenses" ? "Expenses" : "Net",
                      ]}
                    />
                    <Bar
                      dataKey="income"
                      name="income"
                      fill="hsl(var(--chart-2))"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={36}
                    />
                    <Bar
                      dataKey="expenses"
                      name="expenses"
                      fill="hsl(var(--chart-3))"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
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

        {/* Right column: Upcoming Bills + Account Breakdown */}
        <div className="flex flex-col gap-6">
          {/* Upcoming Bills */}
          <Card className="bg-card border-border flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Upcoming Bills</CardTitle>
                <Link href="/bills" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  All bills <ArrowRight className="h-3 w-3" />
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
                      className="flex items-start justify-between gap-2 rounded-sm cursor-pointer hover:bg-muted/40 transition-colors py-1.5 px-1 -mx-1"
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">{bill.billName}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          {bill.daysUntilDue === 0 ? (
                            <span className="text-destructive font-medium">Due today</span>
                          ) : bill.daysUntilDue === 1 ? (
                            <span className="text-chart-4">Due tomorrow</span>
                          ) : bill.daysUntilDue <= 5 ? (
                            <span className="text-chart-4">
                              Due in {bill.daysUntilDue}d
                            </span>
                          ) : (
                            <span>Due in {bill.daysUntilDue}d</span>
                          )}
                          <span className="opacity-40">·</span>
                          <span>{format(new Date(bill.dueDate + "T00:00:00"), "MMM d")}</span>
                        </span>
                      </div>
                      <span className="text-sm font-mono font-medium shrink-0">
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

          {/* Net Worth breakdown by account type */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">By Account Type</CardTitle>
                <Link href="/accounts" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
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
                <div className="space-y-2.5">
                  {Object.entries(accountsByType).map(([type, total]) => (
                    <div key={type} className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">
                        {TYPE_LABELS[type] ?? type}
                      </span>
                      <span
                        className={`text-sm font-mono font-medium ${
                          total >= 0 ? "text-foreground" : "text-chart-3"
                        }`}
                      >
                        {total < 0 ? "−" : ""}
                        {fmt(Math.abs(total))}
                      </span>
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
