import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListBills,
  useListPaySchedules,
  useUpdateBill,
  useUpdatePaySchedule,
  useRegenerateForecast,
  getListForecastQueryKey,
  getGetMonthlyForecastQueryKey,
  getListBillsQueryKey,
  getListPaySchedulesQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Bill, PaySchedule } from "@workspace/api-client-react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormatCurrency } from "@/components/ui/format-currency";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { getCategoryEmoji } from "@/utils/categoryIcons";
import { monthlyFactor } from "@/lib/bill-math";

const moneyCell = "text-right font-mono";

function SummaryCard({ label, amount, color }: { label: string; amount: number; color?: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold font-mono" style={color ? { color } : { color: "#0D2B45" }}>
        <FormatCurrency amount={amount} />
      </p>
    </div>
  );
}

function InlineAmountEditor({
  amount,
  onSave,
  saving,
}: {
  amount: number;
  onSave: (next: number) => void;
  saving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(amount));

  const save = () => {
    const next = Number(value);
    setEditing(false);
    if (!Number.isFinite(next) || next < 0 || next === amount) {
      setValue(String(amount));
      return;
    }
    onSave(next);
  };

  if (editing) {
    return (
      <Input
        type="number"
        step="0.01"
        min="0"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(String(amount));
            setEditing(false);
          }
        }}
        className="h-7 w-28 font-mono text-right inline-block"
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <button
      type="button"
      disabled={saving}
      onClick={(e) => {
        e.stopPropagation();
        setValue(String(amount));
        setEditing(true);
      }}
      className="font-mono rounded px-1.5 py-0.5 hover:bg-muted transition-colors"
      title="Click to edit amount"
    >
      <FormatCurrency amount={amount} />
    </button>
  );
}

function BarRow({ label, amount, max, color }: { label: string; amount: number; max: number; color: string }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (Math.abs(amount) / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex-1 h-5 rounded bg-muted/50 overflow-hidden">
        <div className="h-full rounded" style={{ width: `${width}%`, backgroundColor: color }} />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-sm"><FormatCurrency amount={amount} /></span>
    </div>
  );
}

export function BudgetTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading: billsLoading } = useListBills();
  const { data: paySchedules, isLoading: payLoading } = useListPaySchedules();
  const updateBill = useUpdateBill();
  const updatePaySchedule = useUpdatePaySchedule();
  const regenerateForecast = useRegenerateForecast();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const isLoading = billsLoading || payLoading;

  const afterSave = (kind: "pay" | "bill") => {
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPaySchedulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    regenerateForecast.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListForecastQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMonthlyForecastQueryKey() });
        toast({
          title: "Updated",
          description: `Your ${kind} record has been saved and all future forecast rows will reflect this change.`,
        });
      },
      onError: () => {
        toast({
          title: "Forecast sync failed",
          description: "Your change was saved but the forecast could not be updated. Go to Forecast and click Regenerate.",
          variant: "destructive",
        });
      },
    });
  };

  const saveBillAmount = (bill: Bill, next: number) => {
    updateBill.mutate(
      { id: bill.id, data: { amount: next } },
      {
        onSuccess: () => afterSave("bill"),
        onError: () => toast({ title: "Failed to update bill", variant: "destructive" }),
      },
    );
  };

  const savePayAmount = (pay: PaySchedule, next: number) => {
    updatePaySchedule.mutate(
      { id: pay.id, data: { amount: next } },
      {
        onSuccess: () => afterSave("pay"),
        onError: () => toast({ title: "Failed to update pay schedule", variant: "destructive" }),
      },
    );
  };

  const monthlyIncome = useMemo(
    () => (paySchedules ?? []).reduce((s, p) => s + p.amount * monthlyFactor(p.frequency), 0),
    [paySchedules],
  );

  const groups = useMemo(() => {
    const byCategory: Record<string, Bill[]> = {};
    for (const bill of bills ?? []) {
      if (!bill.isActive || bill.amountType === "positive") continue;
      (byCategory[bill.category] ??= []).push(bill);
    }
    return Object.entries(byCategory)
      .map(([category, list]) => ({
        category,
        bills: list.sort((a, b) => b.amount * monthlyFactor(b.frequency) - a.amount * monthlyFactor(a.frequency)),
        monthlyTotal: list.reduce((s, b) => s + b.amount * monthlyFactor(b.frequency), 0),
      }))
      .sort((a, b) => b.monthlyTotal - a.monthlyTotal);
  }, [bills]);

  const totalBills = useMemo(() => groups.reduce((s, g) => s + g.monthlyTotal, 0), [groups]);
  const netCashFlow = monthlyIncome - totalBills;
  const pctOfIncome = (v: number) => (monthlyIncome > 0 ? `${((v / monthlyIncome) * 100).toFixed(1)}%` : "—");

  const toggle = (cat: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard label="Monthly Income" amount={monthlyIncome} />
        <SummaryCard label="Monthly Bills" amount={totalBills} />
        <SummaryCard
          label="Net Cash Flow"
          amount={netCashFlow}
          color={netCashFlow >= 0 ? "#059669" : "#dc2626"}
        />
      </div>

      <Card className="border-card-border bg-card rounded-xl overflow-hidden">
        {groups.length === 0 && (paySchedules ?? []).length === 0 ? (
          <EmptyState
            icon={<Wallet className="h-8 w-8" />}
            title="No budget data yet"
            description="Add pay schedules and active bills to build your monthly budget."
            className="border-0 bg-transparent rounded-none"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>Source / Category</TableHead>
                <TableHead>Frequency / Bills</TableHead>
                <TableHead className="text-right">Monthly Equivalent</TableHead>
                <TableHead className="text-right">% of Income</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Income section */}
              <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={4} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Income
                </TableCell>
              </TableRow>
              {(paySchedules ?? []).map((p) => (
                <TableRow key={p.id} className="border-border">
                  <TableCell className="font-medium">
                    <span className="mr-2" style={{ fontSize: 16, lineHeight: 1 }}>💼</span>
                    {p.employerName}
                  </TableCell>
                  <TableCell className="capitalize text-sm text-muted-foreground">{p.frequency}</TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-2">
                      <InlineAmountEditor
                        amount={p.amount}
                        onSave={(next) => savePayAmount(p, next)}
                        saving={updatePaySchedule.isPending}
                      />
                      <span className="font-mono text-sm text-muted-foreground w-24 text-right">
                        <FormatCurrency amount={p.amount * monthlyFactor(p.frequency)} />
                        <span className="text-[10px]"> / mo</span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
              <TableRow className="border-border bg-muted/40 hover:bg-muted/40 font-semibold">
                <TableCell>Total Income</TableCell>
                <TableCell />
                <TableCell className={moneyCell}><FormatCurrency amount={monthlyIncome} /></TableCell>
                <TableCell />
              </TableRow>

              {/* Bills section */}
              <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={4} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bills
                </TableCell>
              </TableRow>
              {groups.map((g) => {
                const open = expanded.has(g.category);
                return (
                  <Fragment key={g.category}>
                    <TableRow className="border-border cursor-pointer" onClick={() => toggle(g.category)}>
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span style={{ fontSize: 16, lineHeight: 1 }}>{getCategoryEmoji(g.category)}</span>
                          {g.category}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {g.bills.length} bill{g.bills.length === 1 ? "" : "s"}
                      </TableCell>
                      <TableCell className={moneyCell}><FormatCurrency amount={g.monthlyTotal} /></TableCell>
                      <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>{pctOfIncome(g.monthlyTotal)}</TableCell>
                    </TableRow>
                    {open &&
                      g.bills.map((bill) => (
                        <TableRow key={`${g.category}-${bill.id}`} className="border-border bg-muted/20 hover:bg-muted/20">
                          <TableCell className="pl-12 text-sm text-muted-foreground">{bill.billName}</TableCell>
                          <TableCell className="capitalize text-sm text-muted-foreground">{bill.frequency}</TableCell>
                          <TableCell className="text-right">
                            <span className="inline-flex items-center gap-2">
                              <InlineAmountEditor
                                amount={bill.amount}
                                onSave={(next) => saveBillAmount(bill, next)}
                                saving={updateBill.isPending}
                              />
                              <span className="font-mono text-sm text-muted-foreground w-24 text-right">
                                <FormatCurrency amount={bill.amount * monthlyFactor(bill.frequency)} />
                                <span className="text-[10px]"> / mo</span>
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>
                            {pctOfIncome(bill.amount * monthlyFactor(bill.frequency))}
                          </TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
              <TableRow className="border-border bg-muted/40 hover:bg-muted/40 font-semibold">
                <TableCell>Total Bills</TableCell>
                <TableCell />
                <TableCell className={moneyCell}><FormatCurrency amount={totalBills} /></TableCell>
                <TableCell className={moneyCell}>{pctOfIncome(totalBills)}</TableCell>
              </TableRow>
              <TableRow className="border-border font-semibold">
                <TableCell>Net Cash Flow</TableCell>
                <TableCell />
                <TableCell className={moneyCell} style={{ color: netCashFlow >= 0 ? "#059669" : "#dc2626" }}>
                  <FormatCurrency amount={netCashFlow} />
                </TableCell>
                <TableCell className={moneyCell}>{pctOfIncome(netCashFlow)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Income vs Bills vs Net visual */}
      {(monthlyIncome > 0 || totalBills > 0) && (
        <Card className="border-card-border bg-card rounded-xl p-5 space-y-3">
          <BarRow label="Income" amount={monthlyIncome} max={monthlyIncome || totalBills} color="var(--color-carolina)" />
          <BarRow label="Bills" amount={totalBills} max={monthlyIncome || totalBills} color="#dc2626" />
          <BarRow label="Net" amount={netCashFlow} max={monthlyIncome || totalBills} color="#059669" />
        </Card>
      )}
    </div>
  );
}
