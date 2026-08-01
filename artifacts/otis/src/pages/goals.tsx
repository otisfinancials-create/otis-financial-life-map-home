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
  useListAccounts,
  getListGoalsQueryKey,
  getListBillsQueryKey,
  type Goal,
  type GoalInput,
} from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
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

function wholeMonthsBetween(startIso: string, targetIso: string): number {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ty, tm, td] = targetIso.split("-").map(Number);
  let months = (ty - sy) * 12 + (tm - sm);
  if (td < sd) months -= 1;
  return months;
}

function previewContribution(f: FormState): number | null {
  const target = parseFloat(f.targetAmount);
  const saved = parseFloat(f.alreadySaved || "0");
  if (!f.startDate || !f.targetDate || !(target > 0)) return null;
  const months = wholeMonthsBetween(f.startDate, f.targetDate);
  if (months < 1) return null;
  const remainingCents = Math.round(target * 100) - Math.round(saved * 100);
  if (remainingCents <= 0) return 0;
  return Math.ceil(remainingCents / months / 500 - 1e-9) * 5;
}

export default function Goals() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { sync: syncForecast } = useSyncForecast();
  const { data: goals, isLoading } = useListGoals();
  const { data: accounts } = useListAccounts();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListGoalsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
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
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-border">
                <span className="text-sm text-muted-foreground">Include in forecast</span>
                <Switch
                  checked={g.status === "committed"}
                  disabled={commitGoal.isPending || uncommitGoal.isPending}
                  onCheckedChange={(on) =>
                    on ? commitGoal.mutate({ id: g.id }) : uncommitGoal.mutate({ id: g.id })
                  }
                  data-testid={`switch-commit-goal-${g.id}`}
                />
              </div>
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
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={form.goalType} onValueChange={(v) => setForm({ ...form, goalType: v as FormState["goalType"] })}>
                  <SelectTrigger data-testid="select-goal-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="accumulation">Accumulation (build savings)</SelectItem>
                    <SelectItem value="spend">Spend (save up, then buy)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="goal-day">Contribution day of month</Label>
                <Input id="goal-day" data-testid="input-goal-day" type="number" min={1} max={31} value={form.contributionDay} onChange={(e) => setForm({ ...form, contributionDay: e.target.value })} />
              </div>
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
                <Label htmlFor="goal-target-date">Target date</Label>
                <Input id="goal-target-date" data-testid="input-goal-target-date" type="date" value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} />
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
