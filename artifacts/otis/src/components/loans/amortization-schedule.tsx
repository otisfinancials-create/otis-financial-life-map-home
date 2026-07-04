import { useMemo, useState } from "react";
import { TrendingDown, Clock, Calendar } from "lucide-react";

import { useGetLoanAmortization } from "@workspace/api-client-react";
import type { Loan } from "@workspace/api-client-react";

import { Card, CardContent } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { computeAmortization, toYearly } from "./amortization";

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const formatMonthYear = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });

interface AmortizationScheduleProps {
  loan: Loan;
}

export function AmortizationSchedule({ loan }: AmortizationScheduleProps) {
  const { data, isLoading } = useGetLoanAmortization(loan.id);
  const [view, setView] = useState<"all" | "yearly">("yearly");
  const [extraInput, setExtraInput] = useState("");

  const extra = useMemo(() => {
    const parsed = parseFloat(extraInput);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [extraInput]);

  // Baseline is computed client-side too so the simulator comparison is consistent.
  const baseline = useMemo(() => computeAmortization(loan, 0), [loan]);
  const simulated = useMemo(() => computeAmortization(loan, extra), [loan, extra]);

  const monthsSaved = baseline.numberOfPayments - simulated.numberOfPayments;
  const interestSaved = baseline.totalInterest - simulated.totalInterest;

  if (isLoading) {
    return <Skeleton className="h-[300px] w-full" />;
  }

  if (!data || data.schedule.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This loan cannot be amortized — the monthly payment does not cover the accruing interest.
        Increase the monthly payment to see a payoff schedule.
      </div>
    );
  }

  const yearlyRows = toYearly(data.schedule);

  return (
    <div className="space-y-6 p-4 sm:p-6 bg-muted/10">
      {/* Schedule summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <TrendingDown className="h-3.5 w-3.5" />
              Total Interest
            </div>
            <div className="mt-1 text-xl font-bold tracking-tight text-red-600">
              <FormatCurrency amount={data.totalInterest} />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Total Amount Paid
            </div>
            <div className="mt-1 text-xl font-bold tracking-tight text-foreground">
              <FormatCurrency amount={data.totalPaid} />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              Payoff Date
            </div>
            <div className="mt-1 text-xl font-bold tracking-tight text-foreground">
              {data.payoffDate ? formatMonthYear(data.payoffDate) : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Extra payment simulator */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-6">
          <h4 className="text-sm font-semibold text-foreground">What if I pay extra each month?</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            See how much faster you could be debt-free by adding to your monthly payment.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[220px_1fr] sm:items-center">
            <div className="space-y-1.5">
              <Label htmlFor={`extra-${loan.id}`} className="text-xs">Extra monthly payment</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id={`extra-${loan.id}`}
                  type="number"
                  min="0"
                  step="50"
                  inputMode="decimal"
                  placeholder="0"
                  className="pl-7 font-mono"
                  value={extraInput}
                  onChange={(e) => setExtraInput(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">New Payoff</div>
                <div className={cn("mt-1 text-sm font-bold tracking-tight", extra > 0 ? "text-primary" : "text-foreground")}>
                  {simulated.payoffDate ? formatMonthYear(simulated.payoffDate) : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Time Saved</div>
                <div className={cn("mt-1 text-sm font-bold tracking-tight", monthsSaved > 0 ? "text-emerald-600" : "text-foreground")}>
                  {monthsSaved > 0
                    ? `${Math.floor(monthsSaved / 12)}y ${monthsSaved % 12}m`
                    : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Interest Saved</div>
                <div className={cn("mt-1 text-sm font-bold tracking-tight", interestSaved > 0.5 ? "text-emerald-600" : "text-foreground")}>
                  {interestSaved > 0.5 ? <FormatCurrency amount={interestSaved} /> : "—"}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Schedule table */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground">Amortization Schedule</h4>
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && setView(v as "all" | "yearly")}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="yearly" className="text-xs">Yearly</ToggleGroupItem>
            <ToggleGroupItem value="all" className="text-xs">All Payments</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="max-h-[440px] overflow-auto rounded-lg border border-border bg-card">
          {view === "yearly" ? (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <TableHead>Year</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Interest</TableHead>
                  <TableHead className="text-right">Ending Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yearlyRows.map((row) => (
                  <TableRow key={row.year}>
                    <TableCell className="font-medium">{row.year}</TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={row.paymentTotal} /></TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={row.principalTotal} /></TableCell>
                    <TableCell className="text-right font-mono text-xs text-red-600"><FormatCurrency amount={row.interestTotal} /></TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={row.endingBalance} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Payment</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Interest</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.schedule.map((entry) => (
                  <TableRow key={entry.paymentNumber}>
                    <TableCell className="text-muted-foreground">{entry.paymentNumber}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{formatDate(entry.paymentDate)}</TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.paymentAmount} /></TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.principal} /></TableCell>
                    <TableCell className="text-right font-mono text-xs text-red-600"><FormatCurrency amount={entry.interest} /></TableCell>
                    <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.remainingBalance} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
