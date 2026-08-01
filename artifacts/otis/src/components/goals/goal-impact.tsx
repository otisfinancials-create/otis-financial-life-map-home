import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Scale } from "lucide-react";
import { type GoalSurplus, type Goal } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormatCurrency } from "@/components/ui/format-currency";

/**
 * Impact view + tradeoff options (design §4) and multiple-goals readout (§7.1).
 *
 * All date math here mirrors the server's generateBillOccurrences: monthly
 * occurrences on `day`, clamped to month length, compared as YYYY-MM-DD
 * strings. Never compute months independently — the divisor and these
 * projections must come from the same occurrence walk or they drift (that
 * exact fencepost bug already happened once).
 */

/** nth monthly occurrence (1-based) on `day` starting at startIso, clamped. */
export function nthOccurrence(startIso: string, day: number, n: number): string | null {
  let y = Number(startIso.slice(0, 4));
  let m = Number(startIso.slice(5, 7));
  let count = 0;
  for (let i = 0; i < 1200; i++) {
    const last = new Date(y, m, 0).getDate();
    const occ = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Math.max(day, 1), last)).padStart(2, "0")}`;
    if (occ >= startIso) {
      count++;
      if (count === n) return occ;
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return null;
}

/**
 * The date a goal is fully funded at `monthly` per contribution: the
 * occurrence on which cumulative contributions first cover the remainder.
 */
export function impliedFundedDate(
  startIso: string,
  day: number,
  targetAmount: number,
  alreadySaved: number,
  monthly: number,
): string | null {
  const remaining = Math.round(targetAmount * 100) - Math.round(alreadySaved * 100);
  if (remaining <= 0) return startIso;
  if (!(monthly > 0)) return null;
  const n = Math.ceil(remaining / Math.round(monthly * 100));
  if (n > 1200) return null;
  return nthOccurrence(startIso, day, n);
}

const roundUp5 = (n: number) => Math.ceil(n / 5 - 1e-9) * 5;

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

type ImpactProps = {
  /** Ledger-derived month detail (advisory month-by-month toggle only). */
  surplus: GoalSurplus | undefined;
  /** Budget-derived available surplus (= Budget tab net cash flow) — the
   * headline baseline. Must come from useBudgetMath, never the ledger. */
  availableSurplus: number | null;
  monthly: number | null; // computed contribution for the drafted terms
  startDate: string;
  targetDate: string;
  contributionDay: number;
  targetAmount: number;
  alreadySaved: number;
  /** When editing an already-committed goal, its current contribution is
   * already subtracted from availableSurplus — add it back for a fair test. */
  editingCommittedContribution?: number;
  onApplyTargetDate: (iso: string) => void;
};

export function GoalImpactPanel(props: ImpactProps) {
  const { surplus, monthly, startDate, targetDate, contributionDay, targetAmount, alreadySaved } = props;
  const [customAmount, setCustomAmount] = useState("");
  const [monthsOpen, setMonthsOpen] = useState(false);

  const baseline = useMemo(() => {
    if (props.availableSurplus == null) return null;
    return Math.round((props.availableSurplus + (props.editingCommittedContribution ?? 0)) * 100) / 100;
  }, [props.availableSurplus, props.editingCommittedContribution]);

  const surplusRateDate = useMemo(
    () => (baseline != null && baseline > 0
      ? impliedFundedDate(startDate, contributionDay, targetAmount, alreadySaved, baseline)
      : null),
    [baseline, startDate, contributionDay, targetAmount, alreadySaved],
  );
  const midAmount = useMemo(() => {
    if (monthly == null || baseline == null || monthly <= baseline) return null;
    const mid = roundUp5((monthly + Math.max(baseline, 0)) / 2);
    return mid > 0 && mid < monthly ? mid : null;
  }, [monthly, baseline]);
  const midDate = useMemo(
    () => (midAmount != null ? impliedFundedDate(startDate, contributionDay, targetAmount, alreadySaved, midAmount) : null),
    [midAmount, startDate, contributionDay, targetAmount, alreadySaved],
  );
  const customMonthly = parseFloat(customAmount);
  const customDate = useMemo(
    () => (customMonthly > 0 ? impliedFundedDate(startDate, contributionDay, targetAmount, alreadySaved, customMonthly) : null),
    [customMonthly, startDate, contributionDay, targetAmount, alreadySaved],
  );

  if (monthly == null || baseline == null) return null;
  const fits = monthly <= baseline;
  const negativeMonths = (surplus?.months ?? []).filter((m) => m.available < 0).length;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm" data-testid="panel-goal-impact">
      {fits ? (
        <p className="flex items-start gap-2" data-testid="text-impact-fits">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
          <span>
            You have <FormatCurrency amount={baseline} />/month surplus. This uses{" "}
            <FormatCurrency amount={monthly} /> of it.
          </span>
        </p>
      ) : (
        <>
          <p className="flex items-start gap-2 text-amber-700 dark:text-amber-500 font-medium" data-testid="text-impact-tight">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              <FormatCurrency amount={monthly} />/month exceeds your <FormatCurrency amount={baseline} /> surplus.
              You'd need to cut spending or extend the date.
            </span>
          </p>
          <ul className="space-y-1.5 pl-1" data-testid="list-tradeoff-options">
            <li>
              • <FormatCurrency amount={monthly} />/month hits your date ({fmtDate(targetDate)}).
            </li>
            {baseline > 0 && surplusRateDate && (
              <li className="flex items-center gap-2 flex-wrap">
                <span>
                  • You have <FormatCurrency amount={baseline} /> surplus — at that rate you'd reach it around{" "}
                  {fmtDate(surplusRateDate)}.
                </span>
                {surplusRateDate > targetDate && (
                  <Button variant="outline" size="sm" className="h-6 px-2 text-xs" data-testid="button-apply-surplus-date"
                    onClick={() => props.onApplyTargetDate(surplusRateDate)}>
                    Push date to {surplusRateDate}
                  </Button>
                )}
              </li>
            )}
            {baseline <= 0 && (
              <li className="text-muted-foreground">
                • Your surplus is <FormatCurrency amount={baseline} /> — at that rate this goal never funds without cuts elsewhere.
              </li>
            )}
            {midAmount != null && midDate && midDate > targetDate && (
              <li className="flex items-center gap-2 flex-wrap">
                <span>
                  • Save <FormatCurrency amount={midAmount} />/month and push the date to {fmtDate(midDate)}.
                </span>
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs" data-testid="button-apply-mid-date"
                  onClick={() => props.onApplyTargetDate(midDate)}>
                  Push date to {midDate}
                </Button>
              </li>
            )}
          </ul>
          <div className="flex items-end gap-2 pt-1">
            <div className="grid gap-1">
              <Label htmlFor="impact-custom" className="text-xs text-muted-foreground">Try a monthly amount</Label>
              <Input id="impact-custom" data-testid="input-tradeoff-amount" type="number" min={0} className="h-8 w-32"
                value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} placeholder={String(monthly)} />
            </div>
            {customMonthly > 0 && (
              customDate ? (
                <div className="flex items-center gap-2 pb-1 flex-wrap" data-testid="text-tradeoff-custom">
                  <span className="text-muted-foreground">funds it around {fmtDate(customDate)}</span>
                  {customDate !== targetDate && (
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs" data-testid="button-apply-custom-date"
                      onClick={() => props.onApplyTargetDate(customDate)}>
                      Use that date
                    </Button>
                  )}
                </div>
              ) : (
                <span className="text-muted-foreground pb-1">too far out to project</span>
              )
            )}
          </div>
        </>
      )}

      {surplus && (
      <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setMonthsOpen((o) => !o)} data-testid="button-toggle-surplus-months">
        <ChevronDown className={`h-3 w-3 transition-transform ${monthsOpen ? "rotate-180" : ""}`} />
        Month-by-month forecast net{negativeMonths > 0 ? ` (${negativeMonths} negative month${negativeMonths > 1 ? "s" : ""})` : ""} — averages hide lumpy months
      </button>
      )}
      {monthsOpen && surplus && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-xs font-mono" data-testid="list-surplus-months">
          {surplus.months.map((m) => (
            <div key={m.month} className={`flex justify-between gap-2 ${m.available < 0 ? "text-destructive font-semibold" : ""}`}>
              <span>{m.month}</span>
              <span><FormatCurrency amount={m.available} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Multiple-goals readout (§7.1): committed contributions vs GROSS surplus.
 *
 * Always visible — headroom must be shown BEFORE anything is committed.
 * All numbers are pure functions of current bills/pay/goals state (budget
 * math + goals query), never the forecast ledger, so the value cannot
 * drift with commit/uncommit history.
 */
export function MultipleGoalsCard({
  grossSurplus,
  goals,
}: {
  /** Budget-derived gross surplus (= Budget tab net cash flow before goal contributions). */
  grossSurplus: number | null;
  goals: Goal[] | undefined;
}) {
  if (grossSurplus == null) return null;
  const committed = (goals ?? []).filter((g) => g.status === "committed");
  const need = Math.round(committed.reduce((s, g) => s + g.monthlyContribution, 0) * 100) / 100;
  const have = Math.round(grossSurplus * 100) / 100;
  const remaining = Math.round((have - need) * 100) / 100;
  const over = need > have;
  return (
    <Card className={`border-card-border bg-card rounded-xl p-4 space-y-2 ${over ? "border-destructive/40" : ""}`} data-testid="card-multiple-goals">
      <div className="flex items-center gap-2">
        <Scale className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm">Committed goals vs. your income</h2>
      </div>
      {committed.length === 0 ? (
        <p className="text-sm" data-testid="text-goals-vs-income">
          Your income currently supports <FormatCurrency amount={have} />/month in goal contributions.
        </p>
      ) : (
        <>
          <p className={`text-sm ${over ? "text-destructive font-medium" : ""}`} data-testid="text-goals-vs-income">
            Your goals need <FormatCurrency amount={need} />/mo — your income supports{" "}
            <FormatCurrency amount={have} />/mo{over ? ". Something has to give." : "."}
          </p>
          <ul className="text-sm text-muted-foreground space-y-0.5" data-testid="list-committed-goal-contributions">
            {committed.map((g) => (
              <li key={g.id} className="flex justify-between gap-4">
                <span className="truncate">{g.name}</span>
                <span className="font-mono"><FormatCurrency amount={g.monthlyContribution} />/mo</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            After these contributions, <FormatCurrency amount={remaining} />/mo remains available for new goals.
          </p>
        </>
      )}
    </Card>
  );
}
