import { Fragment, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightSmall } from "lucide-react";

import {
  useListForecast,
  getListForecastQueryKey,
  useListPaySchedules,
  useListCardCompositions,
} from "@workspace/api-client-react";
import { foldCarryover } from "@/components/bills/card-composition";
import type { Bill } from "@workspace/api-client-react";

import { Card } from "@/components/ui/card";
import { BillDialog } from "@/components/bills/bill-dialog";
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
import { isGoalContribution, GOAL_SAVINGS_LABEL } from "@/lib/bill-groups";
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

/** Explicit cycle status marker for card-paid bills (pending / hit / missed). */
function CycleStatusBadge({ status }: { status: "pending" | "hit" | "missed" }) {
  const map = {
    hit: { icon: "✅", title: "Posted to the card" },
    pending: { icon: "⏳", title: "Not posted yet this cycle" },
    missed: { icon: "🔴", title: "Missed — no matching charge this cycle" },
  } as const;
  const { icon, title } = map[status];
  return (
    <span title={title} aria-label={title} style={{ fontSize: 13, lineHeight: 1 }}>
      {icon}
    </span>
  );
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
  const [, navigate] = useLocation();
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
  // MONTH ATTRIBUTION: a cycle's bills and envelopes belong to the month the
  // CYCLE CLOSES. That matches the Bills tab, which shows you the mid-flight
  // cycle today — the spending happens during the cycle, so a mid-cycle user
  // sees what has posted and what hasn't in the current month, not shifted a
  // month out to when the card payment is due. (The payment itself still
  // lands in the forecast on the due date — one aggregate, shown once.)
  // The endpoint filters by DUE date, which trails cycle end by up to ~2
  // months, so fetch a wider due window and filter by cycle end here.
  const dueWindowEnd = useMemo(() => {
    const d = new Date(`${end}T00:00:00`);
    d.setDate(d.getDate() + 70);
    return d.toISOString().slice(0, 10);
  }, [end]);
  const { data: allCompositions = [] } = useListCardCompositions({ dueStart: start, dueEnd: dueWindowEnd });
  const compositions = useMemo(
    () => allCompositions.filter((c) => c.cycleEnd >= start && c.cycleEnd <= end),
    [allCompositions, start, end],
  );

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

    // Planned & paid come from the actual forecast occurrences in THIS month
    // — no monthly normalization. A bill with no occurrence this month is not
    // planned this month (dropped below); a quarterly bill whose occurrence
    // lands here shows its full amount. Paid = occurrences marked actual
    // (not missed). Planned = every non-missed occurrence's amount.
    const plannedByBill = new Map<number, number>();
    const paidByBill = new Map<number, number>();
    let incomePlanned = 0;
    let incomePaid = 0;
    for (const tx of txs) {
      if (tx.status === "missed" || tx.isCcParent) continue;
      if (tx.sourceBillId != null) {
        plannedByBill.set(tx.sourceBillId, (plannedByBill.get(tx.sourceBillId) ?? 0) + Math.abs(tx.amount));
        if (tx.isActual) {
          paidByBill.set(tx.sourceBillId, (paidByBill.get(tx.sourceBillId) ?? 0) + Math.abs(tx.amount));
        }
      } else if (tx.sourcePayId != null) {
        incomePlanned += Math.abs(tx.amount);
        if (tx.isActual) incomePaid += Math.abs(tx.amount);
      }
    }

    // Card-paid bills have NO forecast rows of their own — they exist only as
    // card_cycle_bills composition rows, and their money reaches the forecast
    // through the is_cc_parent aggregate (which we skip above). Read them
    // directly from the cycle compositions instead, attributed to the month
    // the cycle's payment is due — the same convention that already places
    // the envelope groups (and the payment itself) in a month. Amounts are
    // the real per-cycle expected/actual values — never normalized, so a
    // quarterly bill appears only in cycles containing an occurrence.
    const cardBillAgg = new Map<number, { planned: number; paid: number; statuses: string[] }>();
    for (const c of compositions) {
      for (const cb of c.bills) {
        if (cb.billId == null) continue;
        const agg = cardBillAgg.get(cb.billId) ?? { planned: 0, paid: 0, statuses: [] };
        agg.planned += cb.expectedAmount;
        agg.paid += cb.actualAmount ?? 0;
        agg.statuses.push(cb.status);
        cardBillAgg.set(cb.billId, agg);
      }
    }

    interface BillRow {
      bill: Bill;
      planned: number;
      paid: number;
      /** Explicit cycle status for card-paid bills (pending / hit / missed). */
      cycleStatus?: "pending" | "hit" | "missed";
    }
    // Goal contributions group under their own "Goal Savings" heading —
    // kind-based (billKind), never by their free-text category. Same shared
    // concept as the Budget page (see lib/bill-groups.ts).
    const goalRows: BillRow[] = [];
    const byCategory = new Map<string, BillRow[]>();
    for (const b of activeBills) {
      const fromForecast = plannedByBill.has(b.id);
      const fromCycle = !fromForecast && cardBillAgg.has(b.id);
      // Only bills with a forecast occurrence OR a card-cycle allocation this
      // month appear. A bill is counted from exactly ONE source — forecast
      // rows win, so nothing can appear both as a bank-paid occurrence and a
      // cycle child.
      if (!fromForecast && !fromCycle) continue;
      const agg = fromCycle ? cardBillAgg.get(b.id)! : undefined;
      const row: BillRow = agg
        ? {
            bill: b,
            planned: agg.planned,
            paid: agg.paid,
            cycleStatus: agg.statuses.every((s) => s === "hit")
              ? "hit"
              : agg.statuses.includes("pending")
                ? "pending"
                : "missed",
          }
        : {
            bill: b,
            planned: plannedByBill.get(b.id) ?? 0,
            paid: paidByBill.get(b.id) ?? 0,
          };
      if (isGoalContribution(b)) {
        goalRows.push(row);
        continue;
      }
      const list = byCategory.get(b.category) ?? [];
      list.push(row);
      byCategory.set(b.category, list);
    }
    goalRows.sort((a, b) => b.planned - a.planned);
    const goalGroup = {
      rows: goalRows,
      planned: goalRows.reduce((s, r) => s + r.planned, 0),
      paid: goalRows.reduce((s, r) => s + r.paid, 0),
    };

    const categories = Array.from(byCategory.entries())
      .map(([category, rows]) => ({
        category,
        rows: rows.sort((a, b) => b.planned - a.planned),
        planned: rows.reduce((s, r) => s + r.planned, 0),
        paid: rows.reduce((s, r) => s + r.paid, 0),
      }))
      .sort((a, b) => b.planned - a.planned);

    // Card envelopes for cycles due this month. "Paid" = charges actually
    // allocated to the envelope so far. Bills allocated to cycles already
    // appear in their categories above — only envelopes are added here.
    const cardGroups = compositions
      .map((c) => {
        const rows = foldCarryover(c.envelopes).filter((e) => e.plannedAmount > 0.005 || e.spentAmount > 0.005);
        return {
          key: `card-${c.cycleId}`,
          cardName: c.accountName,
          rows,
          planned: rows.reduce((s, e) => s + e.plannedAmount, 0),
          paid: rows.reduce((s, e) => s + e.spentAmount, 0),
        };
      })
      .filter((g) => g.rows.length > 0);

    const envPlanned = cardGroups.reduce((s, g) => s + g.planned, 0);
    const envPaid = cardGroups.reduce((s, g) => s + g.paid, 0);
    const totalPlanned = categories.reduce((s, c) => s + c.planned, 0) + envPlanned + goalGroup.planned;
    const totalPaid = categories.reduce((s, c) => s + c.paid, 0) + envPaid + goalGroup.paid;

    return { incomePlanned, incomePaid, categories, goalGroup, cardGroups, totalPlanned, totalPaid };
  }, [bills, txs, compositions]);

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
        ) : data.categories.length === 0 && data.goalGroup.rows.length === 0 && data.cardGroups.length === 0 && paySchedules.length === 0 ? (
          <div className="px-5 py-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              Add bills and a pay schedule to compare what you planned against what happened.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <BillDialog trigger={<Button size="sm">Add a bill</Button>} />
              <Button size="sm" variant="outline" onClick={() => navigate("/pay-schedules")}>Add a pay schedule</Button>
            </div>
          </div>
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
                            {r.cycleStatus ? (
                              <CycleStatusBadge status={r.cycleStatus} />
                            ) : (
                              <StatusIcon planned={r.planned} paid={r.paid} />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </Fragment>
                );
              })}
              {/* Goal Savings section — savings toward goals, never "Other" spend */}
              {data.goalGroup.rows.length > 0 && (
                <Fragment>
                  <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={5} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {GOAL_SAVINGS_LABEL}
                    </TableCell>
                  </TableRow>
                  <TableRow className="border-border cursor-pointer" onClick={() => toggle("goal-savings")} data-testid="row-pva-goal-savings">
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {expanded.has("goal-savings") ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRightSmall className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span style={{ fontSize: 16, lineHeight: 1 }}>🎯</span>
                        {GOAL_SAVINGS_LABEL}
                      </span>
                    </TableCell>
                    <TableCell className={moneyCell}><FormatCurrency amount={data.goalGroup.planned} /></TableCell>
                    <TableCell className={moneyCell}><FormatCurrency amount={data.goalGroup.paid} /></TableCell>
                    <TableCell className={`${moneyCell} ${data.goalGroup.planned - data.goalGroup.paid < -0.005 ? "text-red-600" : ""}`}>
                      <FormatCurrency amount={data.goalGroup.planned - data.goalGroup.paid} />
                    </TableCell>
                    <TableCell className="text-center">
                      <StatusIcon planned={data.goalGroup.planned} paid={data.goalGroup.paid} />
                    </TableCell>
                  </TableRow>
                  {expanded.has("goal-savings") &&
                    data.goalGroup.rows.map((r) => (
                      <TableRow key={`goal-savings-${r.bill.id}`} className="border-border bg-muted/20 hover:bg-muted/20">
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
              )}
              {/* Card envelopes section */}
              {data.cardGroups.length > 0 && (
                <TableRow className="border-border bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={5} className="py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Card Envelopes
                  </TableCell>
                </TableRow>
              )}
              {data.cardGroups.map((g) => {
                const open = expanded.has(g.key);
                return (
                  <Fragment key={g.key}>
                    <TableRow className="border-border cursor-pointer" onClick={() => toggle(g.key)} data-testid={`row-pva-envelopes-${g.key}`}>
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRightSmall className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span style={{ fontSize: 16, lineHeight: 1 }}>💳</span>
                          {g.cardName}
                        </span>
                      </TableCell>
                      <TableCell className={moneyCell}><FormatCurrency amount={g.planned} /></TableCell>
                      <TableCell className={moneyCell}><FormatCurrency amount={g.paid} /></TableCell>
                      <TableCell className={`${moneyCell} ${g.planned - g.paid < -0.005 ? "text-red-600" : ""}`}>
                        <FormatCurrency amount={g.planned - g.paid} />
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusIcon planned={g.planned} paid={g.paid} />
                      </TableCell>
                    </TableRow>
                    {open &&
                      g.rows.map((e) => (
                        <TableRow key={`${g.key}-${e.key}`} className="border-border bg-muted/20 hover:bg-muted/20">
                          <TableCell className="pl-12 text-sm text-muted-foreground">
                            {e.name}
                            {e.includesCarryover && <span className="ml-1.5 text-[10px] text-muted-foreground/70">(incl. carryover)</span>}
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>
                            <FormatCurrency amount={e.plannedAmount} />
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm text-muted-foreground`}>
                            <FormatCurrency amount={e.spentAmount} />
                          </TableCell>
                          <TableCell className={`${moneyCell} text-sm ${e.plannedAmount - e.spentAmount < -0.005 ? "text-red-600" : "text-muted-foreground"}`}>
                            <FormatCurrency amount={e.plannedAmount - e.spentAmount} />
                          </TableCell>
                          <TableCell className="text-center">
                            <StatusIcon planned={e.plannedAmount} paid={e.spentAmount} />
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
