import { useMemo, useState } from "react";
import { Target, Plus, Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListGoals,
  useCreateGoal,
  useUpdateGoal,
  useDeleteGoal,
  useCommitGoal,
  useUncommitGoal,
  useStopGoalContributions,
  useRemoveGoalPurchase,
  useListAccounts,
  useGetGoalSurplus,
  getGetGoalSurplusQueryKey,
  getListGoalsQueryKey,
  getListBillsQueryKey,
  type Goal,
  type GoalInput,
} from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";
import { useBudgetMath } from "@/hooks/use-budget-math";
import { GoalImpactPanel, MultipleGoalsCard } from "@/components/goals/goal-impact";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { FormatCurrency } from "@/components/ui/format-currency";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FormState = {
  name: string;
  goalType: "spend" | "accumulation";
  targetAmount: string;
  alreadySaved: string;
  startDate: string;
  targetDate: string;
  sourceAccountId: string;
  destinationAccountId: string;
  contributionDay: string;
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const emptyForm = (): FormState => ({
  name: "",
  goalType: "accumulation",
  targetAmount: "",
  alreadySaved: "0",
  startDate: todayIso(),
  targetDate: "",
  sourceAccountId: "",
  destinationAccountId: "",
  contributionDay: "1",
});

/**
 * Number of monthly contribution occurrences the forecast will emit between
 * start and target for the chosen contribution day — mirrors the server's
 * generateBillOccurrences (monthly, day clamped to month length).
 */
function contributionCount(startIso: string, targetIso: string, day: number): number {
  let y = Number(startIso.slice(0, 4));
  let m = Number(startIso.slice(5, 7));
  let count = 0;
  for (let i = 0; i < 2000; i++) {
    const last = new Date(y, m, 0).getDate();
    const occ = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Math.max(day, 1), last)).padStart(2, "0")}`;
    if (occ > targetIso) break;
    if (occ >= startIso) count++;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return count;
}

function previewContribution(f: FormState): number | null {
  const target = parseFloat(f.targetAmount);
  const saved = parseFloat(f.alreadySaved || "0");
  if (!f.startDate || !f.targetDate || !(target > 0)) return null;
  const day = parseInt(f.contributionDay || "1", 10);
  if (!(day >= 1 && day <= 31)) return null;
  const months = contributionCount(f.startDate, f.targetDate, day);
  if (months < 1) return null;
  const remainingCents = Math.round(target * 100) - Math.round(saved * 100);
  if (remainingCents <= 0) return 0;
  return Math.ceil(remainingCents / months / 500 - 1e-9) * 5;
}

/**
 * Part 4 — progress toward the target, driven by the ACTUAL bucket (money
 * that really moved), never the projection. On-track compares the actual
 * bucket against what the schedule says should have been saved BY TODAY
 * (alreadySaved + contribution × occurrences ≤ today).
 */
function GoalProgress({ goal, onStopContributions, stopping }: { goal: Goal; onStopContributions: (goal: Goal) => void; stopping: boolean }) {
  const actual = goal.actualBucket ?? goal.alreadySaved;
  const target = goal.targetAmount;
  const pct = target > 0 ? Math.min(100, Math.max(0, (actual / target) * 100)) : 0;
  const today = todayIso();
  const dueByNow = contributionCount(goal.startDate, today < goal.targetDate ? today : goal.targetDate, goal.contributionDay);
  const expectedByNow = Math.min(target, goal.alreadySaved + goal.monthlyContribution * dueByNow);
  // §7.7/3c — status must reflect reality. At or past target it reads as
  // reached/exceeded, never "on track", regardless of schedule arithmetic.
  const overfunded = actual > target + 0.005;
  const reached = !overfunded && actual >= target - 0.005;
  const behind = !reached && !overfunded && actual < expectedByNow - 0.005;
  const badge = overfunded
    ? { label: "Target exceeded", cls: "bg-amber-100 text-amber-700 border-transparent" }
    : reached
      ? { label: "Target reached", cls: "bg-emerald-100 text-emerald-700 border-transparent" }
      : behind
        ? { label: "Behind", cls: "bg-destructive/10 text-destructive border-transparent" }
        : { label: "On track", cls: "bg-emerald-100 text-emerald-700 border-transparent" };
  return (
    <div className="space-y-1 pt-1" data-testid={`progress-goal-${goal.id}`}>
      <div className="flex items-center justify-between text-sm">
        <span>
          <span className="font-mono font-medium"><FormatCurrency amount={actual} /></span>{" "}
          <span className="text-muted-foreground">of <FormatCurrency amount={target} /> saved</span>
          {overfunded && (
            <span className="text-amber-700"> — {Math.round((actual / target) * 100)}% of target</span>
          )}
        </span>
        <Badge variant="secondary" className={badge.cls} data-testid={`badge-goal-status-${goal.id}`}>
          {badge.label}
        </Badge>
      </div>
      <Progress value={pct} className="h-2" />
      {behind && (
        <p className="text-xs text-muted-foreground">
          Schedule expected <FormatCurrency amount={expectedByNow} /> saved by today —{" "}
          <span className="text-destructive font-medium"><FormatCurrency amount={Math.round((expectedByNow - actual) * 100) / 100} /> behind</span>.
        </p>
      )}
      {goal.targetReachedEarly && (
        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2" data-testid={`prompt-stop-contributions-${goal.id}`}>
          <p className="text-sm text-emerald-900">
            You hit your target early — you have <FormatCurrency amount={actual} /> saved against a{" "}
            <FormatCurrency amount={target} /> target, and contributions are still scheduled. Stop contributing?
          </p>
          <p className="text-xs text-emerald-800/80">
            Stopping ends the contribution schedule today and removes future transfers from your forecast. Money already saved stays saved.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="border-emerald-300 text-emerald-800"
            disabled={stopping}
            onClick={() => onStopContributions(goal)}
            data-testid={`button-stop-contributions-${goal.id}`}
          >
            {stopping ? "Stopping…" : "Stop contributing"}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Goals() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { sync: syncForecast } = useSyncForecast();
  const { data: goals, isLoading } = useListGoals();
  const { data: accounts } = useListAccounts();
  const { data: surplus } = useGetGoalSurplus();
  // Headline surplus numbers come from the shared budget math (same
  // computation as the Budget tab, by construction). The ledger-based
  // endpoint is kept only for the advisory month-by-month detail.
  const budget = useBudgetMath();


  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListGoalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetGoalSurplusQueryKey() });
    syncForecast();
  };

  const onApiError = (err: unknown) => {
    const msg =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "Something went wrong. Please try again.";
    setFormError(msg);
  };

  const createGoal = useCreateGoal({
    mutation: {
      onSuccess: () => {
        setDialogOpen(false);
        invalidate();
        toast({ title: "Goal created", description: "Draft goals don't affect your forecast until you commit them." });
      },
      onError: onApiError,
    },
  });
  const updateGoal = useUpdateGoal({
    mutation: {
      onSuccess: () => {
        setDialogOpen(false);
        invalidate();
        toast({ title: "Goal updated" });
      },
      onError: onApiError,
    },
  });
  const deleteGoal = useDeleteGoal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Goal deleted" });
      },
      onError: (err) =>
        toast({
          title: "Couldn't delete goal",
          description: (err as { response?: { data?: { error?: string } } })?.response?.data?.error,
          variant: "destructive",
        }),
    },
  });
  const commitGoal = useCommitGoal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Goal committed", description: "Its monthly contribution now appears in Bills and your forecast." });
      },
      onError: (err) =>
        toast({
          title: "Couldn't commit goal",
          description: (err as { response?: { data?: { error?: string } } })?.response?.data?.error,
          variant: "destructive",
        }),
    },
  });
  const uncommitGoal = useUncommitGoal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Goal uncommitted", description: "Its contribution line was removed from your forecast." });
      },
      onError: (err) =>
        toast({
          title: "Couldn't uncommit goal",
          description: (err as { response?: { data?: { error?: string } } })?.response?.data?.error,
          variant: "destructive",
        }),
    },
  });

  const stopContributions = useStopGoalContributions({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Contributions stopped", description: "Future transfers were removed from your forecast. Everything already saved stays saved." });
      },
      onError: (err) =>
        toast({
          title: "Couldn't stop contributions",
          description: (err as { response?: { data?: { error?: string } } })?.response?.data?.error,
          variant: "destructive",
        }),
    },
  });

  const removePurchase = useRemoveGoalPurchase({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Purchase removed", description: "Both the purchase and its funding transfer were taken out of the forecast." });
      },
      onError: (err) =>
        toast({
          title: "Couldn't remove purchase",
          description: (err as { response?: { data?: { error?: string } } })?.response?.data?.error,
          variant: "destructive",
        }),
    },
  });

  const poolAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.isForecastAccount),
    [accounts],
  );
  const outsideAccounts = useMemo(
    () => (accounts ?? []).filter((a) => !a.isForecastAccount && a.accountType !== "credit_card"),
    [accounts],
  );
  const accountName = (id: number) => accounts?.find((a) => a.id === id)?.accountName ?? `Account ${id}`;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setDialogOpen(true);
  };
  const openEdit = (g: Goal) => {
    setEditing(g);
    setForm({
      name: g.name,
      goalType: g.goalType,
      targetAmount: String(g.targetAmount),
      alreadySaved: String(g.alreadySaved),
      startDate: g.startDate,
      targetDate: g.targetDate,
      sourceAccountId: String(g.sourceAccountId),
      destinationAccountId: String(g.destinationAccountId),
      contributionDay: String(g.contributionDay),
    });
    setFormError(null);
    setDialogOpen(true);
  };

  const submit = () => {
    setFormError(null);
    const body: GoalInput = {
      name: form.name.trim(),
      goalType: form.goalType,
      targetAmount: parseFloat(form.targetAmount),
      alreadySaved: parseFloat(form.alreadySaved || "0"),
      startDate: form.startDate,
      targetDate: form.targetDate,
      sourceAccountId: parseInt(form.sourceAccountId, 10),
      destinationAccountId: parseInt(form.destinationAccountId, 10),
      contributionDay: parseInt(form.contributionDay, 10),
    };
    if (!body.name || !(body.targetAmount > 0) || !body.startDate || !body.targetDate) {
      setFormError("Name, target amount, start date, and target date are required.");
      return;
    }
    if (!body.sourceAccountId || !body.destinationAccountId) {
      setFormError("Pick both a source and a destination account.");
      return;
    }
    if (editing) updateGoal.mutate({ id: editing.id, data: body });
    else createGoal.mutate({ data: body });
  };

  const preview = previewContribution(form);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Goals</h1>
          <p className="text-muted-foreground mt-1">
            Plan a goal, see the monthly number, then commit it to your forecast when you're ready.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-add-goal">
          <Plus className="h-4 w-4 mr-1" /> New goal
        </Button>
      </div>

      <MultipleGoalsCard grossSurplus={budget.isLoading ? null : budget.grossSurplus} goals={goals} />

      {isLoading ? (
        <Card className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-6 w-1/2" />
        </Card>
      ) : !goals || goals.length === 0 ? (
        <EmptyState
          icon={<Target className="h-8 w-8" />}
          title="No goals yet"
          description="Create a goal to see what saving for it does to the rest of your money."
          action={<Button onClick={openCreate}>Create your first goal</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {goals.map((g) => (
            <Card key={g.id} className="border-card-border bg-card rounded-xl p-5 space-y-3" data-testid={`card-goal-${g.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold truncate">{g.name}</h2>
                    <Badge variant="secondary" className="capitalize shrink-0">
                      {g.goalType}
                    </Badge>
                    {g.status === "committed" && (
                      <Badge className="bg-primary/10 text-primary border-transparent shrink-0">In forecast</Badge>
                    )}
                    {g.status === "completed" && (
                      <Badge className="bg-emerald-100 text-emerald-700 border-transparent shrink-0">Completed</Badge>
                    )}
                    {g.status === "cancelled" && (
                      <Badge variant="secondary" className="shrink-0">Purchase removed</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    <FormatCurrency amount={g.targetAmount} /> by {g.targetDate}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(g)} data-testid={`button-edit-goal-${g.id}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={g.status === "committed"}
                    onClick={() => deleteGoal.mutate({ id: g.id })}
                    data-testid={`button-delete-goal-${g.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">Monthly contribution:</span>{" "}
                  <span className="font-mono font-medium">
                    <FormatCurrency amount={g.monthlyContribution} />
                  </span>{" "}
                  <span className="text-muted-foreground">on day {g.contributionDay}</span>
                </p>
                <p className="text-muted-foreground truncate">
                  {accountName(g.sourceAccountId)} → {accountName(g.destinationAccountId)}
                </p>
                {g.billId != null && (
                  <GoalProgress
                    goal={g}
                    onStopContributions={(goal) => stopContributions.mutate({ id: goal.id })}
                    stopping={stopContributions.isPending}
                  />
                )}
                {g.goalType === "spend" && g.projectedBucketAtSpendDate != null && (
                  <p className="text-muted-foreground">
                    Saved by spend date:{" "}
                    <span className="font-mono font-medium text-foreground">
                      <FormatCurrency amount={g.projectedBucketAtSpendDate} />
                    </span>
                    {(g.shortfall ?? 0) > 0 && (
                      <span className="ml-1.5 text-destructive font-medium">
                        <FormatCurrency amount={g.shortfall!} /> short
                      </span>
                    )}
                  </p>
                )}
                {g.bucketInvariant && !g.bucketInvariant.ok && (
                  <p className="text-destructive text-xs font-medium">
                    Bucket check failed: stored <FormatCurrency amount={g.bucketInvariant.stored} /> ≠ derived{" "}
                    <FormatCurrency amount={g.bucketInvariant.derived} /> — contribution history may be inconsistent.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-border">
                <span className="text-sm text-muted-foreground">Include in forecast</span>
                <Switch
                  checked={g.billId != null}
                  disabled={commitGoal.isPending || uncommitGoal.isPending}
                  onCheckedChange={(on) =>
                    on ? commitGoal.mutate({ id: g.id }) : uncommitGoal.mutate({ id: g.id })
                  }
                  data-testid={`switch-commit-goal-${g.id}`}
                />
              </div>
              {g.goalType === "spend" && g.status === "committed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  disabled={removePurchase.isPending}
                  onClick={() => removePurchase.mutate({ id: g.id })}
                  data-testid={`button-remove-purchase-${g.id}`}
                >
                  Purchase didn't happen
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit goal" : "New goal"}</DialogTitle>
            <DialogDescription>
              Money moves from your spending account to a separate savings account each month. The destination must be
              outside your forecast pool — that's what makes the goal visible in your forecast.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="goal-name">Name</Label>
              <Input id="goal-name" data-testid="input-goal-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Emergency fund" />
            </div>
            <div className="grid gap-2">
              <Label>Will you spend this on a date, or are you building it up?</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-testid="button-goal-type-spend"
                  onClick={() => setForm({ ...form, goalType: "spend" })}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    form.goalType === "spend" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className="block text-sm font-medium">Spend it on a date</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">Save up, then make the purchase</span>
                </button>
                <button
                  type="button"
                  data-testid="button-goal-type-accumulation"
                  onClick={() => setForm({ ...form, goalType: "accumulation" })}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    form.goalType === "accumulation" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className="block text-sm font-medium">Build it up</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">Grow savings toward a target</span>
                </button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="goal-day">Contribution day of month</Label>
              <Input id="goal-day" data-testid="input-goal-day" type="number" min={1} max={31} value={form.contributionDay} onChange={(e) => setForm({ ...form, contributionDay: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="goal-target">Target amount</Label>
                <Input id="goal-target" data-testid="input-goal-target" type="number" min={0} value={form.targetAmount} onChange={(e) => setForm({ ...form, targetAmount: e.target.value })} placeholder="6000" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="goal-saved">Already saved</Label>
                <Input id="goal-saved" data-testid="input-goal-saved" type="number" min={0} value={form.alreadySaved} onChange={(e) => setForm({ ...form, alreadySaved: e.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="goal-start">Start date</Label>
                <Input id="goal-start" data-testid="input-goal-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="goal-target-date">{form.goalType === "spend" ? "Spend date (purchase day)" : "Target date"}</Label>
                <Input id="goal-target-date" data-testid="input-goal-target-date" type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
                {form.goalType === "spend" && (
                  <p className="text-xs text-muted-foreground">The purchase shows up in your forecast on this day, funded by what you've saved.</p>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Money leaves from (spending account)</Label>
              <Select value={form.sourceAccountId} onValueChange={(v) => setForm({ ...form, sourceAccountId: v })}>
                <SelectTrigger data-testid="select-goal-source">
                  <SelectValue placeholder="Pick a forecast pool account" />
                </SelectTrigger>
                <SelectContent>
                  {poolAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.accountName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Money goes to (savings — outside your forecast pool)</Label>
              <Select value={form.destinationAccountId} onValueChange={(v) => setForm({ ...form, destinationAccountId: v })}>
                <SelectTrigger data-testid="select-goal-destination">
                  <SelectValue placeholder="Pick a savings/investment account" />
                </SelectTrigger>
                <SelectContent>
                  {outsideAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.accountName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                If the destination were inside your pool, the transfer would cancel itself out and the goal would have
                no visible effect.
              </p>
            </div>
            {preview != null && (
              <p className="text-sm" data-testid="text-goal-preview">
                Monthly contribution:{" "}
                <span className="font-mono font-medium">
                  <FormatCurrency amount={preview} />
                </span>{" "}
                <span className="text-muted-foreground">(rounded up to the nearest $5 so you arrive a little early)</span>
              </p>
            )}
            {preview != null && (
              <GoalImpactPanel
                surplus={surplus}
                availableSurplus={budget.isLoading ? null : budget.availableSurplus}
                monthly={preview}
                startDate={form.startDate}
                targetDate={form.targetDate}
                contributionDay={parseInt(form.contributionDay || "1", 10)}
                targetAmount={parseFloat(form.targetAmount) || 0}
                alreadySaved={parseFloat(form.alreadySaved || "0") || 0}
                editingCommittedContribution={
                  editing && editing.status === "committed" ? editing.monthlyContribution : undefined
                }
                onApplyTargetDate={(iso) => setForm((f) => ({ ...f, targetDate: iso }))}
              />
            )}
            {formError && (
              <p className="text-sm text-destructive" data-testid="text-goal-error">
                {formError}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={createGoal.isPending || updateGoal.isPending} data-testid="button-save-goal">
              {editing ? "Save changes" : "Create goal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
