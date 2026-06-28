import { useGetDashboardSummary, useGetUpcomingBills, useListAccounts } from "@workspace/api-client-react";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, AlertCircle, Building2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { format, addDays } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: upcomingBills, isLoading: isLoadingBills } = useGetUpcomingBills();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();

  // Mock chart data for demonstration, normally this would come from forecast API
  const cashFlowData = [
    { month: "Jan", income: 14500, expenses: 8200 },
    { month: "Feb", income: 14500, expenses: 7800 },
    { month: "Mar", income: 14500, expenses: 9100 },
    { month: "Apr", income: 14500, expenses: 8400 },
    { month: "May", income: 18500, expenses: 8500 }, // Bonus month
    { month: "Jun", income: 14500, expenses: 9800 }, // Vacation
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Your financial life at a glance.</p>
        </div>
      </div>

      {/* Primary Metrics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Worth</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight">
                  <FormatCurrency amount={summary?.netWorth || 0} compact />
                </div>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <span className="text-chart-2 flex items-center"><ArrowUpRight className="h-3 w-3" /> 2.4%</span> from last month
                </p>
              </>
            )}
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Cash Flow</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <>
                <div className="text-2xl font-bold tracking-tight">
                  <FormatCurrency amount={summary?.monthlyCashFlow || 0} compact showSign />
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs">
                  <span className="text-chart-2"><FormatCurrency amount={summary?.monthlyIncome || 0} compact /> in</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-chart-3"><FormatCurrency amount={summary?.monthlyExpenses || 0} compact /> out</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Assets</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight">
                <FormatCurrency amount={summary?.totalAssets || 0} compact />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Liabilities</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? (
              <Skeleton className="h-8 w-[120px]" />
            ) : (
              <div className="text-2xl font-bold tracking-tight">
                <FormatCurrency amount={summary?.totalLiabilities || 0} compact />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Chart */}
        <Card className="col-span-1 lg:col-span-2 bg-card border-border">
          <CardHeader>
            <CardTitle>Cash Flow Trend</CardTitle>
            <CardDescription>Income vs Expenses over the next 6 months</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cashFlowData} margin={{ top: 20, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="month" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                    dy={10}
                  />
                  <YAxis 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                    tickFormatter={(value) => `$${value/1000}k`}
                  />
                  <Tooltip 
                    cursor={{ fill: 'hsl(var(--muted)/0.3)' }}
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                    formatter={(value: number) => [new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value), '']}
                  />
                  <Bar dataKey="income" name="Income" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="expenses" name="Expenses" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Upcoming Bills */}
        <Card className="bg-card border-border flex flex-col">
          <CardHeader>
            <CardTitle>Upcoming Bills</CardTitle>
            <CardDescription>Next 30 days</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto pr-2">
            {isLoadingBills ? (
              <div className="space-y-4">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="flex justify-between items-center">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            ) : upcomingBills?.length ? (
              <div className="space-y-5">
                {upcomingBills.slice(0, 6).map((bill) => (
                  <div key={bill.id} className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{bill.billName}</span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        {bill.daysUntilDue === 0 ? (
                          <span className="text-chart-4 font-medium">Due today</span>
                        ) : bill.daysUntilDue === 1 ? (
                          <span className="text-chart-4">Due tomorrow</span>
                        ) : (
                          <span>Due in {bill.daysUntilDue} days</span>
                        )}
                        <span className="opacity-50">•</span>
                        {format(new Date(bill.dueDate), 'MMM d')}
                      </span>
                    </div>
                    <div className="text-sm font-medium">
                      <FormatCurrency amount={bill.amount} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                No bills due soon.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
