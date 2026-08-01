import { useMemo } from "react";
import {
  useListBills,
  useListPaySchedules,
  useListCardCompositions,
} from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";
import { monthlyFactor } from "@/lib/bill-math";
import { isGoalContribution } from "@/lib/bill-groups";
import { foldCarryover, nearestCyclePerCard, todayIso } from "@/components/bills/card-composition";

/**
 * THE budget computation — single source of truth shared by the Budget tab
 * and the goals surplus readouts. "Income supports $X/month" and the Budget
 * tab's net cash flow must be the same number by construction, so both
 * derive from this hook. Never re-derive these totals elsewhere.
 *
 * grossSurplus  = income − bills − envelopes (before goal contributions)
 * availableSurplus = grossSurplus − committed goal contributions
 *                  = the Budget tab's net cash flow.
 *
 * These are pure functions of the bills / pay-schedules / card-compositions
 * queries — no forecast-ledger dependence — so they cannot drift with
 * interaction history (commit/uncommit races with forecast regeneration).
 */
export function useBudgetMath() {
  const { data: bills, isLoading: billsLoading } = useListBills();
  const { data: paySchedules, isLoading: payLoading } = useListPaySchedules();
  const { data: compositions, isLoading: compositionsLoading } = useListCardCompositions({
    dueStart: todayIso(),
  });

  const monthlyIncome = useMemo(
    () => (paySchedules ?? []).reduce((s, p) => s + p.amount * monthlyFactor(p.frequency), 0),
    [paySchedules],
  );

  const goalBills = useMemo(
    () => (bills ?? []).filter((b) => b.isActive && isGoalContribution(b)),
    [bills],
  );
  const totalGoalSavings = useMemo(
    () => goalBills.reduce((s, b) => s + b.amount * monthlyFactor(b.frequency), 0),
    [goalBills],
  );

  const groups = useMemo(() => {
    const byCategory: Record<string, Bill[]> = {};
    for (const bill of bills ?? []) {
      if (!bill.isActive || bill.amountType === "positive" || isGoalContribution(bill)) continue;
      (byCategory[bill.category] ??= []).push(bill);
    }
    return Object.entries(byCategory)
      .map(([category, list]) => ({
        category,
        bills: list.sort(
          (a, b) => b.amount * monthlyFactor(b.frequency) - a.amount * monthlyFactor(a.frequency),
        ),
        monthlyTotal: list.reduce((s, b) => s + b.amount * monthlyFactor(b.frequency), 0),
      }))
      .sort((a, b) => b.monthlyTotal - a.monthlyTotal);
  }, [bills]);

  // Card envelopes: each card's current cycle is ~monthly, so envelope
  // planned amounts ARE the monthly equivalent. Bills allocated to a cycle
  // already appear in their own categories above — only envelopes are added
  // here, so nothing is counted twice. Carryover is folded, never listed.
  const envelopeGroups = useMemo(() => {
    return nearestCyclePerCard(compositions ?? [])
      .map((c) => {
        const envelopes = foldCarryover(c.envelopes).filter((e) => e.plannedAmount > 0.005);
        return {
          key: `card-${c.accountId}`,
          cardName: c.accountName,
          envelopes,
          monthlyTotal: envelopes.reduce((s, e) => s + e.plannedAmount, 0),
        };
      })
      .filter((g) => g.envelopes.length > 0);
  }, [compositions]);

  const totalEnvelopes = useMemo(
    () => envelopeGroups.reduce((s, g) => s + g.monthlyTotal, 0),
    [envelopeGroups],
  );
  const totalRegularBills = useMemo(() => groups.reduce((s, g) => s + g.monthlyTotal, 0), [groups]);
  const totalBills = totalRegularBills + totalEnvelopes + totalGoalSavings;
  const netCashFlow = monthlyIncome - totalBills;

  // Surplus semantics for goals: gross = before goal contributions,
  // available = after (identical to the Budget tab's net cash flow).
  const grossSurplus = netCashFlow + totalGoalSavings;
  const availableSurplus = netCashFlow;

  return {
    isLoading: billsLoading || payLoading || compositionsLoading,
    bills,
    paySchedules,
    monthlyIncome,
    goalBills,
    totalGoalSavings,
    groups,
    envelopeGroups,
    totalEnvelopes,
    totalBills,
    netCashFlow,
    grossSurplus,
    availableSurplus,
  };
}
