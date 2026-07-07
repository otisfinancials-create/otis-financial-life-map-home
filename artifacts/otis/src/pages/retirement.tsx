import { useMemo, useState } from "react";
import { PiggyBank, TrendingUp, Wallet, Target, Pencil } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  useGetRetirementSettings,
  useGetRetirementSummary,
  useGetRetirementProjection,
  useListAccounts,
} from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { FormatCurrency } from "@/components/ui/format-currency";
import { EmptyState } from "@/components/ui/empty-state";
import { RetirementSettingsForm } from "@/components/retirement/settings-form";
import { EditContributionDialog } from "@/components/retirement/edit-contribution-dialog";
import {
  projectRetirement,
  RETIREMENT_SUBTYPE_LABELS,
  RETIREMENT_ACCOUNT_TYPES,
} from "@/components/retirement/projection";

function readinessColor(score: number): string {
  if (score >= 80) return "bg-green-500";
  if (score >= 50) return "bg-orange-500";
  return "bg-red-500";
}

function compactCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export default function Retirement() {
  const { data: settings, isLoading: settingsLoading } = useGetRetirementSettings();
  const { data: summary, isLoading: summaryLoading } = useGetRetirementSummary();
  const { data: projection, isLoading: projectionLoading } = useGetRetirementProjection();
  const { data: accounts, isLoading: accountsLoading } = useListAccounts();

  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  // What-if sliders (deltas relative to saved assumptions)
  const [extraContribution, setExtraContribution] = useState(0);
  const [whatIfRetireAge, setWhatIfRetireAge] = useState<number | null>(null);
  const [whatIfReturn, setWhatIfReturn] = useState<number | null>(null);

  const retirementAccounts = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) => a.isAsset && RETIREMENT_ACCOUNT_TYPES.includes(a.accountType),
      ),
    [accounts],
  );

  const hasBaseline =
    settings?.currentAge != null &&
    settings.retirementAge > (settings.currentAge ?? 0) &&
    summary != null;

  const scenarioRetireAge = whatIfRetireAge ?? settings?.retirementAge ?? 65;
  const scenarioReturn = whatIfReturn ?? settings?.expectedReturnRate ?? 7;
  const scenarioActive =
    extraContribution > 0 ||
    (whatIfRetireAge !== null && whatIfRetireAge !== settings?.retirementAge) ||
    (whatIfReturn !== null && whatIfReturn !== settings?.expectedReturnRate);

  const scenarioPoints = useMemo(() => {
    if (!hasBaseline || !scenarioActive || !settings || !summary) return null;
    return projectRetirement(
      summary.currentSavings,
      summary.monthlyContribution + extraContribution,
      settings.currentAge as number,
      scenarioRetireAge,
      scenarioReturn,
    );
  }, [hasBaseline, scenarioActive, settings, summary, extraContribution, scenarioRetireAge, scenarioReturn]);

  const chartData = useMemo(() => {
    const base = projection?.points ?? [];
    const byAge = new Map<number, { age: number; year: number; projected?: number; scenario?: number; goal?: number }>();
    for (const p of base) {
      byAge.set(p.age, { age: p.age, year: p.year, projected: p.projected, goal: projection?.retirementGoal ?? undefined });
    }
    if (scenarioPoints) {
      for (const p of scenarioPoints) {
        const existing = byAge.get(p.age);
        if (existing) {
          existing.scenario = p.projected;
        } else {
          byAge.set(p.age, { age: p.age, year: p.year, scenario: p.projected, goal: projection?.retirementGoal ?? undefined });
        }
      }
    }
    return Array.from(byAge.values()).sort((a, b) => a.age - b.age);
  }, [projection, scenarioPoints]);

  const scenarioFinal = scenarioPoints ? scenarioPoints[scenarioPoints.length - 1].projected : null;
  const scenarioDelta =
    scenarioFinal !== null && projection ? scenarioFinal - projection.projectedValue : null;

  const impactParts: string[] = [];
  if (settings && scenarioActive) {
    if (extraContribution > 0) impactParts.push(`adding $${extraContribution.toLocaleString()} a month`);
    if (whatIfRetireAge !== null && whatIfRetireAge !== settings.retirementAge)
      impactParts.push(`retiring at ${whatIfRetireAge} instead of ${settings.retirementAge}`);
    if (whatIfReturn !== null && whatIfReturn !== settings.expectedReturnRate)
      impactParts.push(`earning ${whatIfReturn}% instead of ${settings.expectedReturnRate}%`);
  }

  // Income summary (4% rule)
  const monthlyFromSavings = projection ? (projection.projectedValue * 0.04) / 12 : 0;
  const socialSecurity = settings?.socialSecurityMonthly ?? 0;
  const totalIncome = monthlyFromSavings + socialSecurity;
  const spendingGoal = settings?.monthlySpendingGoal ?? 0;
  const coverage = spendingGoal > 0 ? Math.round((totalIncome / spendingGoal) * 100) : null;
  const incomeSurplus = totalIncome - spendingGoal;

  const isLoading = settingsLoading || summaryLoading || projectionLoading;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Retirement</h1>
        <p className="text-muted-foreground mt-1">
          Here's where you stand today, and where your current path is taking you.
        </p>
      </div>

      {/* Part A: Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Current Retirement Savings
            </CardTitle>
            <PiggyBank className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight">
                <FormatCurrency amount={summary?.currentSavings ?? 0} compact />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Across all retirement accounts</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Projected at Retirement
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight">
                <FormatCurrency amount={summary?.projectedValue ?? 0} compact />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {settings?.retirementAge ? `If you retire at ${settings.retirementAge}` : "Based on your assumptions"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Monthly Contribution
            </CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <div className="text-2xl font-bold font-mono tracking-tight">
                <FormatCurrency amount={summary?.monthlyContribution ?? 0} compact />
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Going in every month</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Progress to Goal
            </CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : (
              <>
                <div className="text-2xl font-bold font-mono tracking-tight">
                  {Math.min(100, summary?.readinessScore ?? 0)}%
                </div>
                <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${readinessColor(summary?.readinessScore ?? 0)}`}
                    style={{ width: `${Math.min(100, summary?.readinessScore ?? 0)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  You're {Math.min(100, summary?.readinessScore ?? 0)}% of the way to your retirement goal
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Part D: Projection chart */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Your projected savings growth</CardTitle>
            <CardDescription>
              From today until retirement, assuming your contributions and growth continue.
            </CardDescription>
          </div>
          {!isLoading && hasBaseline && projection && (
            projection.onTrack ? (
              <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-green-200">
                On Track
              </Badge>
            ) : (
              <Badge className="bg-red-100 text-red-800 hover:bg-red-100 border-red-200">
                Gap: {compactCurrency(projection.shortfall)}
              </Badge>
            )
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : !hasBaseline ? (
            <EmptyState
              icon={<TrendingUp className="h-8 w-8" />}
              title="Let's set up your projection"
              description="Enter your age and retirement goal in the assumptions below, and we'll chart your path."
            />
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="age"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    label={{ value: "Age", position: "insideBottomRight", offset: -4, fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <YAxis
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => compactCurrency(v)}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--popover))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    itemStyle={{ color: "hsl(var(--foreground))" }}
                    formatter={(value: number, name: string) => {
                      const labels: Record<string, string> = {
                        projected: "On Track",
                        scenario: "What-If",
                        goal: "Goal",
                      };
                      return [compactCurrency(value), labels[name] ?? name];
                    }}
                    labelFormatter={(age: number) => {
                      const point = chartData.find((p) => p.age === age);
                      return point ? `Age ${age} (${point.year})` : `Age ${age}`;
                    }}
                  />
                  <Legend
                    formatter={(value: string) => {
                      const labels: Record<string, string> = {
                        projected: "On Track",
                        scenario: "What-If",
                        goal: "Goal",
                      };
                      return labels[value] ?? value;
                    }}
                    wrapperStyle={{ fontSize: 12 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="projected"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                  />
                  {scenarioPoints && (
                    <Line
                      type="monotone"
                      dataKey="scenario"
                      stroke="#14b8a6"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={false}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="goal"
                    stroke="#9ca3af"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Part E: What-if scenarios */}
      {hasBaseline && settings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What if...</CardTitle>
            <CardDescription>
              Move the sliders to see how small changes shape your future. The teal line shows your new path.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">I contribute more each month</span>
                  <span className="font-mono font-medium">+${extraContribution.toLocaleString()}</span>
                </div>
                <Slider
                  value={[extraContribution]}
                  onValueChange={([v]) => setExtraContribution(v)}
                  min={0}
                  max={5000}
                  step={50}
                />
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">I retire at a different age</span>
                  <span className="font-mono font-medium">{scenarioRetireAge}</span>
                </div>
                <Slider
                  value={[scenarioRetireAge]}
                  onValueChange={([v]) => setWhatIfRetireAge(v)}
                  min={(settings.currentAge ?? 0) + 1}
                  max={80}
                  step={1}
                />
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">My annual return is different</span>
                  <span className="font-mono font-medium">{scenarioReturn.toFixed(1)}%</span>
                </div>
                <Slider
                  value={[scenarioReturn]}
                  onValueChange={([v]) => setWhatIfReturn(v)}
                  min={0}
                  max={12}
                  step={0.5}
                />
              </div>
            </div>
            {scenarioActive && scenarioDelta !== null && impactParts.length > 0 ? (
              <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                {impactParts.join(", ").charAt(0).toUpperCase() + impactParts.join(", ").slice(1)}{" "}
                {scenarioDelta >= 0 ? "adds" : "takes away"}{" "}
                <span className={`font-mono font-semibold ${scenarioDelta >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {compactCurrency(Math.abs(scenarioDelta))}
                </span>{" "}
                {scenarioDelta >= 0 ? "to" : "from"} your projected savings — landing you at{" "}
                <span className="font-mono font-semibold">{compactCurrency(scenarioFinal ?? 0)}</span>.
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 ml-2 text-xs"
                  onClick={() => {
                    setExtraContribution(0);
                    setWhatIfRetireAge(null);
                    setWhatIfReturn(null);
                  }}
                >
                  Reset
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Adjust a slider and we'll instantly show the impact on your projection.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Part F: Retirement income summary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your monthly income in retirement</CardTitle>
            <CardDescription>
              Based on the 4% rule — a steady withdrawal pace designed to last.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">From your savings</span>
                  <FormatCurrency amount={monthlyFromSavings} className="font-medium" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">From Social Security</span>
                  {socialSecurity > 0 ? (
                    <FormatCurrency amount={socialSecurity} className="font-medium" />
                  ) : (
                    <span className="text-muted-foreground text-xs">Not entered yet</span>
                  )}
                </div>
                <div className="border-t pt-3 flex items-center justify-between">
                  <span className="font-medium">Total monthly income</span>
                  <FormatCurrency amount={totalIncome} className="font-semibold" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Your monthly spending goal</span>
                  {spendingGoal > 0 ? (
                    <FormatCurrency amount={spendingGoal} className="font-medium" />
                  ) : (
                    <span className="text-muted-foreground text-xs">Not set yet</span>
                  )}
                </div>
                {coverage !== null && (
                  <div
                    className={`rounded-lg px-4 py-3 mt-2 text-sm ${
                      incomeSurplus >= 0
                        ? "bg-green-50 text-green-800 border border-green-200"
                        : "bg-orange-50 text-orange-800 border border-orange-200"
                    }`}
                  >
                    Your projected retirement income covers {coverage}% of your monthly goal
                    {incomeSurplus >= 0 ? (
                      <> — a surplus of {compactCurrency(incomeSurplus)} a month. Nicely done.</>
                    ) : (
                      <> — a gap of {compactCurrency(Math.abs(incomeSurplus))} a month to close.</>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Part C: Retirement accounts */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your retirement accounts</CardTitle>
            <CardDescription>The accounts powering your projection.</CardDescription>
          </CardHeader>
          <CardContent>
            {accountsLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : retirementAccounts.length === 0 ? (
              <EmptyState
                icon={<PiggyBank className="h-8 w-8" />}
                title="No retirement accounts yet"
                description="Add your retirement accounts in Connected Accounts to get started."
              />
            ) : (
              <div className="space-y-3">
                {retirementAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between rounded-lg border px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{account.accountName}</p>
                        <Badge variant="secondary" className="text-xs shrink-0">
                          {RETIREMENT_SUBTYPE_LABELS[account.retirementSubtype ?? ""] ?? "Other"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {account.institutionName} · Contributing{" "}
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                          maximumFractionDigits: 0,
                        }).format(account.monthlyContribution)}
                        /mo
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <FormatCurrency amount={account.currentBalance} className="font-semibold text-sm" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingAccount(account)}
                      >
                        <Pencil className="h-3.5 w-3.5 mr-1.5" />
                        Edit Contribution
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Part B: Settings form */}
      {settingsLoading || !settings ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <RetirementSettingsForm settings={settings} />
      )}

      <EditContributionDialog account={editingAccount} onClose={() => setEditingAccount(null)} />
    </div>
  );
}
