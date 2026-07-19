import { Fragment, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightSmall } from "lucide-react";

import {
  useListForecast,
  getListForecastQueryKey,
  useListPaySchedules,
} from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { monthlyFactor } from "@/lib/bill-math";
import { getCategoryEmoji } from "@/utils/categoryIcons";

function boundsFor(year: number, month: number): { start: string; end: string; label: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month + 1, 0).getDate();
  const label = new Date(year, month, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  return {
    start: `${year}-${pad(month + 1)}-01`,
    end: `${year}-${pad(month + 1)}-${pad(lastDay)}`,
    label,
  };
}

function StatusIcon({ planned, paid }: { planned: number; paid: number }) {
  const remaining = planned - paid;
  let icon = "🔴";
  let title = "Nothing paid yet";
  if (planned > 0 && remaining <= 0.005) {
    icon = "✅";
    title = "Fully paid";
  } else if (paid > 0.005) {
    icon = "⚠️";
    title = "Partially paid";
  }
  return (
    <span title={title} aria-label={title} style={{ fontSize: 13, lineHeight: 1 }}>
      {icon}
    </span>
  );
}

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

const moneyCell = "text-right font-mono";

export function PlannedVsActualTab({ bills }: { bills: Bill[] }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { start, end, label } = boundsFor(year, month);

  const { data: txs = [], isLoading: txLoading } = useListForecast(
    { startDate: start, endDate: end },
    { query: { queryKey: getListForecastQueryKey({ startDate: start, endDate: end }) } },
  );
  const { data: paySchedules = [], isLoading: payLoading } = useListPaySchedules();

  const isLoading = txLoading || payLoading;

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const toggle = (cat: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  const data = useMemo(() => {
    const activeBills = bills.filter((b) => b.isActive && b.amountType !== "positive");

    // Paid per bill: bill-linked forecast rows marked paid this month (not missed).
    const paidByBill = new Map<number, number>();
    let incomePaid = 0;
    for (const tx of txs) {
      if (!tx.isActual || tx.status === "missed" || tx.isCcParent) continue;
      if (tx.sourceBillId != null) {
        paidByBill.set(tx.sourceBillId, (paidByBill.get(tx.sourceBillId) ?? 0) + Math.abs(tx.amount));
      } else if (tx.sourcePayId != null) {
        incomePaid += Math.abs(tx.amount);
      }
    }

    const incomePlanned = paySchedules.reduce((s, p) => s + p.amount * monthlyFactor(p.frequency), 0);

    interface BillRow {
      bill: Bill;
      planned: number;
      paid: number;
    }
    const byCategory = new Map<string, BillRow[]>();
    for (const b of activeBills) {
      const row: BillRow = {
        bill: b,
        planned: b.amount * monthlyFactor(b.frequency),
        paid: paidByBill.get(b.id) ?? 0,
      };
      const list = byCategory.get(b.category) ?? [];
      list.push(row);
      byCategory.set(b.category, list);
    }

    const categories = Array.from(byCategory.entries())
      .map(([category, rows]) => ({
        category,
        rows: rows.sort((a, b) => b.planned - a.planned),
        planned: rows.reduce((s, r) => s + r.planned, 0),
        paid: rows.reduce((s, r) => s + r.paid, 0),
      }))
      .sort((a, b) => b.planned - a.planned);

    const totalPlanned = categories.reduce((s, c) => s + c.planned, 0);
    const totalPaid = categories.reduce((s, c) => s + c.paid, 0);

    return { incomePlanned, incomePaid, categories, totalPlanned, totalPaid };
  }, [bills, txs, paySchedules]);

  return (
    <div className="space-y-4">
      {/* Month navigator */}
      <div className="flex items-center justify-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[150px] text-center text-sm font-semibold">{label}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shiftMonth(1)} aria-label="Next month">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Summary bar */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard label="Planned" amount={data.totalPlanned} />
          <SummaryCard label="Paid" amount={data.totalPaid} color="#059669" />
          <SummaryCard
            label="Remaining"
            amount={data.totalPlanned - data.totalPaid}
            color={data.totalPlanned - data.totalPaid > 0.005 ? "#dc2626" : "#059669"}
          />
        </div>
      )}

      <Card className="border-card-border bg-card rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-5 space-y-3">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : data.categories.length === 0 && paySchedules.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No active bills or pay schedules yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Planned</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead className="w-10 text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Income section */}
              <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={5} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Income
                </TableCell>
              </TableRow>
              <TableRow className="border-border">
                <TableCell className="font-medium">
                  <span className="mr-2" style={{ fontSize: 16, lineHeight: 1 }}>💼</span>
                  Pay
                </TableCell>
                <TableCell className={moneyCell}><FormatCurrency amount={data.incomePlanned} /></TableCell>
                <TableCell className={moneyCell}><FormatCurrency amount={data.incomePaid} /></TableCell>
                <TableCell className={moneyCell}>
                  <FormatCurrency amount={Math.max(0, data.incomePlanned - data.incomePaid)} />
                </TableCell>
                <TableCell className="text-center">
                  <StatusIcon planned={data.incomePlanned} paid={data.incomePaid} />
                </TableCell>
              </TableRow>

              {/* Bills section */}
              <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={5} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bills
                </TableCell>
              </TableRow>
              {data.categories.map((c) => {
                const open = expanded.has(c.category);
                return (
                  <Fragment key={c.category}>
                    <TableRow
                      className="border-border cursor-pointer"
                      onClick={() => toggle(c.category)}
                    >
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRightSmall className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span style={{ fontSize: 16, lineHeight: 1 }}>{getCategoryEmoji(c.category)}</span>
                          {c.category}
                        </span>
                      </TableCell>
                      <TableCell className={moneyCell}><FormatCurrency amount={c.planned} /></TableCell>
                      <TableCell className={moneyCell}><FormatCurrency amount={c.paid} /></TableCell>
                      <TableCell className={`${moneyCell} ${c.planned - c.paid < -0.005 ? "text-red-600" : ""}`}>
                        <FormatCurrency amount={c.planned - c.paid} />
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusIcon planned={c.planned} paid={c.paid} />
                      </TableCell>
                    </TableRow>
                    {open &&
                      c.rows.map((r) => (
                        <TableRow key={`${c.category}-${r.bill.id}`} className="border-border bg-muted/20 hover:bg-muted/20">
                          <TableCell className="pl-12 text-sm text-muted-foreground">{r.bill.billName}</TableCell>
                          <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>
                            <FormatCurrency amount={r.planned} />
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>
                            <FormatCurrency amount={r.paid} />
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm ${r.planned - r.paid < -0.005 ? "text-red-600" : "text-muted-foreground"}`}>
                            <FormatCurrency amount={r.planned - r.paid} />
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusIcon planned={r.planned} paid={r.paid} />
                          </TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
              <TableRow className="border-border bg-muted/40 hover:bg-muted/40 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className={moneyCell}><FormatCurrency amount={data.totalPlanned} /></TableCell>
                <TableCell className={moneyCell}><FormatCurrency amount={data.totalPaid} /></TableCell>
                <TableCell className={moneyCell}><FormatCurrency amount={data.totalPlanned - data.totalPaid} /></TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Actuals are based on bills marked as paid in your forecast. Connect your accounts via Plaid for
        automatic tracking.
      </p>
    </div>
  );
}
