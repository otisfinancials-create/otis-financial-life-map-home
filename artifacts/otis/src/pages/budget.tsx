import { useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListBills,
  useListPaySchedules,
  useUpdateBill,
  useRegenerateForecast,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormatCurrency } from "@/components/ui/format-currency";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/hooks/use-toast";
import { categoryMeta, getCategoryEmoji } from "@/utils/categoryIcons";
import { monthlyFactor } from "@/lib/bill-math";

function payScheduleMonthly(frequency: string, amount: number): number {
  return amount * monthlyFactor(frequency);
}

interface CategoryGroup {
  category: string;
  bills: Bill[];
  monthlyTotal: number;
}

function SummaryStat({
  label,
  amount,
  color,
}: {
  label: string;
  amount: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-background px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold font-mono" style={color ? { color } : undefined}>
        <FormatCurrency amount={amount} />
      </p>
    </div>
  );
}

function BillAmountEditor({
  bill,
  onSaved,
}: {
  bill: Bill;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(bill.amount));
  const updateBill = useUpdateBill();

  const save = () => {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0) {
      setValue(String(bill.amount));
      setEditing(false);
      return;
    }
    if (next === bill.amount) {
      setEditing(false);
      return;
    }
    updateBill.mutate(
      { id: bill.id, data: { amount: next } },
      {
        onSuccess: () => {
          setEditing(false);
          onSaved();
        },
        onError: () => {
          setValue(String(bill.amount));
          setEditing(false);
        },
      },
    );
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
            setValue(String(bill.amount));
            setEditing(false);
          }
        }}
        className="h-8 w-28 font-mono text-right"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setValue(String(bill.amount));
        setEditing(true);
      }}
      className="font-mono rounded px-1.5 py-0.5 hover:bg-muted transition-colors"
      title="Click to edit amount"
    >
      <FormatCurrency amount={bill.amount} />
    </button>
  );
}

export default function Budget() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading: billsLoading } = useListBills();
  const { data: paySchedules, isLoading: payLoading } = useListPaySchedules();
  const regenerateForecast = useRegenerateForecast();

  const isLoading = billsLoading || payLoading;

  const monthlyIncome = useMemo(
    () =>
      (paySchedules ?? []).reduce(
        (sum, p) => sum + payScheduleMonthly(p.frequency, p.amount),
        0,
      ),
    [paySchedules],
  );

  const groups: CategoryGroup[] = useMemo(() => {
    const byCategory: Record<string, Bill[]> = {};
    for (const bill of bills ?? []) {
      if (!bill.isActive) continue;
      (byCategory[bill.category] ??= []).push(bill);
    }
    return Object.entries(byCategory)
      .map(([category, list]) => ({
        category,
        bills: list,
        monthlyTotal: list.reduce(
          (sum, b) => sum + b.amount * monthlyFactor(b.frequency),
          0,
        ),
      }))
      .sort((a, b) => b.monthlyTotal - a.monthlyTotal);
  }, [bills]);

  const totalBudgeted = useMemo(
    () => groups.reduce((sum, g) => sum + g.monthlyTotal, 0),
    [groups],
  );

  const netBudget = monthlyIncome - totalBudgeted;

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    regenerateForecast.mutate(undefined, {
      onSuccess: () => {
        toast({
          title: "Budget updated",
          description:
            "Your budget has been updated. All future forecast rows will reflect this change.",
        });
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Budget</h1>
        <p className="text-muted-foreground mt-1">
          Your monthly plan, built from your actual data.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryStat
            label="Average Monthly Income"
            amount={monthlyIncome}
            color="#059669"
          />
          <SummaryStat label="Total Budgeted Expenses" amount={totalBudgeted} />
          <SummaryStat
            label="Net Budget"
            amount={netBudget}
            color={netBudget >= 0 ? "#059669" : "#dc2626"}
          />
        </div>
      )}

      <Card className="border-card-border bg-card rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : groups.length > 0 ? (
          <Accordion type="multiple" className="px-4">
            {groups.map((group) => {
              const meta = categoryMeta(group.category);
              const pct =
                monthlyIncome > 0
                  ? (group.monthlyTotal / monthlyIncome) * 100
                  : 0;
              return (
                <AccordionItem
                  key={group.category}
                  value={group.category}
                  className="border-border"
                >
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex flex-1 items-center gap-3 pr-4">
                      <span
                        className="shrink-0"
                        style={{ fontSize: "18px", lineHeight: 1 }}
                        aria-hidden="true"
                      >
                        {getCategoryEmoji(group.category)}
                      </span>
                      <Badge
                        variant="outline"
                        className="font-normal border-transparent"
                        style={{ backgroundColor: meta.bg, color: meta.text }}
                      >
                        {group.category}
                      </Badge>
                      <span className="ml-auto font-mono font-semibold">
                        <FormatCurrency amount={group.monthlyTotal} />
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          / mo
                        </span>
                      </span>
                      <span className="w-16 text-right text-xs text-muted-foreground font-mono">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-1">
                      {group.bills.map((bill) => (
                        <div
                          key={bill.id}
                          className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/40"
                        >
                          <span className="font-medium truncate">
                            {bill.billName}
                          </span>
                          <span className="text-muted-foreground text-sm capitalize">
                            {bill.frequency}
                          </span>
                          <span className="ml-auto text-right">
                            <BillAmountEditor bill={bill} onSaved={handleSaved} />
                          </span>
                          <span className="w-28 text-right font-mono text-sm text-muted-foreground">
                            <FormatCurrency
                              amount={bill.amount * monthlyFactor(bill.frequency)}
                            />
                            <span className="text-[10px]"> / mo</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        ) : (
          <EmptyState
            icon={<Wallet className="h-8 w-8" />}
            title="No budget data yet"
            description="Add active bills to build your monthly budget."
            className="border-0 bg-transparent rounded-none"
          />
        )}
      </Card>
    </div>
  );
}
