import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCheck, PencilLine, Sparkles, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import {
  useListDetectedBillDrafts,
  useConfirmDetectedBill,
  useDismissDetectedBill,
  useListAccounts,
  useMarkDetectedBillsSeen,
  getGetDetectedNewBillCountQueryKey,
  getListDetectedBillDraftsQueryKey,
  getListDetectedBillsQueryKey,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { DetectedBillDraft, ConfirmDetectedBillInput } from "@workspace/api-client-react";
import { BILL_CATEGORIES } from "@workspace/api-zod";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MerchantPicker } from "@/components/bills/merchant-picker";
import { useToast } from "@/hooks/use-toast";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "annually", label: "Annually" },
];

function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

type DraftEdits = {
  billName: string;
  category: string;
  amount: string;
  frequency: string;
  dueDay: string;
  paymentAccountId: number | null;
  matchMerchant: string;
};

function editsFromDraft(draft: DetectedBillDraft): DraftEdits {
  return {
    billName: draft.displayName,
    category: draft.suggestedCategory,
    amount: draft.amount.toFixed(2),
    frequency: draft.frequency,
    dueDay: String(draft.dueDay),
    paymentAccountId: draft.paymentAccountId ?? null,
    matchMerchant: draft.matchMerchant,
  };
}

function overridesFromEdits(draft: DetectedBillDraft, edits: DraftEdits): ConfirmDetectedBillInput {
  const overrides: ConfirmDetectedBillInput = {};
  if (edits.billName.trim() && edits.billName.trim() !== draft.displayName) overrides.billName = edits.billName.trim();
  if (edits.category !== draft.suggestedCategory) overrides.category = edits.category;
  const amount = Number(edits.amount);
  if (Number.isFinite(amount) && amount > 0 && amount !== draft.amount) overrides.amount = amount;
  if (edits.frequency !== draft.frequency) overrides.frequency = edits.frequency as ConfirmDetectedBillInput["frequency"];
  const dueDay = Number(edits.dueDay);
  if (Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31 && dueDay !== draft.dueDay) overrides.dueDay = dueDay;
  if ((edits.paymentAccountId ?? null) !== (draft.paymentAccountId ?? null)) overrides.paymentAccountId = edits.paymentAccountId;
  if (edits.matchMerchant !== draft.matchMerchant) overrides.matchMerchant = edits.matchMerchant || null;
  return overrides;
}

function DraftCard({
  draft,
  state,
  busy,
  onConfirm,
  onDismiss,
}: {
  draft: DetectedBillDraft;
  state: "pending" | "confirmed" | "dismissed";
  busy: boolean;
  onConfirm: (overrides: ConfirmDetectedBillInput) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<DraftEdits>(() => editsFromDraft(draft));
  const { data: accounts } = useListAccounts();
  const isDuplicate = draft.status === "duplicate";
  const settled = state !== "pending";

  const set = <K extends keyof DraftEdits>(key: K, value: DraftEdits[K]) =>
    setEdits((e) => ({ ...e, [key]: value }));

  const evidence = draft.sampleTransactions
    .map((t) => `$${t.amount.toFixed(2)} on ${formatShortDate(t.date)}`)
    .join(", ");

  return (
    <Card
      className={`p-4 space-y-3 ${settled ? "opacity-60" : ""}`}
      data-testid={`draft-${draft.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{editing ? edits.billName : draft.displayName}</span>
            {isDuplicate ? (
              <Badge variant="secondary" data-testid={`badge-duplicate-${draft.id}`}>
                You already track this{draft.duplicateBillName ? ` (${draft.duplicateBillName})` : ""}
              </Badge>
            ) : (
              <Badge variant="outline">{Math.round(draft.confidence * 100)}% confident</Badge>
            )}
            {draft.isNew && state === "pending" && (
              <Badge className="bg-blue-600 text-white" data-testid={`badge-new-${draft.id}`}>
                New
              </Badge>
            )}
            {state === "confirmed" && <Badge className="bg-emerald-600">Confirmed</Badge>}
            {state === "dismissed" && <Badge variant="secondary">Dismissed</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            ${draft.amount.toFixed(2)} · {FREQUENCIES.find((f) => f.value === draft.frequency)?.label ?? draft.frequency} · due day {draft.dueDay}
            {draft.paymentAccountName ? ` · pays from ${draft.paymentAccountName}` : ""}
            {" · "}
            <span className="text-foreground/70">{editing ? edits.category : draft.suggestedCategory}</span>
          </p>
          {evidence && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid={`evidence-${draft.id}`}>
              Detected from: {evidence}
            </p>
          )}
        </div>
        {!settled && (
          <div className="flex shrink-0 gap-2">
            {!isDuplicate && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onConfirm(editing ? overridesFromEdits(draft, edits) : {})}
                data-testid={`button-confirm-${draft.id}`}
              >
                <Check className="mr-1 h-4 w-4" /> Confirm
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing((v) => !v)}
              data-testid={`button-edit-${draft.id}`}
            >
              <PencilLine className="mr-1 h-4 w-4" /> {editing ? "Close" : "Edit"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onDismiss}
              data-testid={`button-dismiss-${draft.id}`}
            >
              <X className="mr-1 h-4 w-4" /> Dismiss
            </Button>
          </div>
        )}
      </div>

      {editing && !settled && (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={edits.billName} onChange={(e) => set("billName", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={edits.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger data-testid={`select-category-${draft.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Amount</Label>
            <Input type="number" step="0.01" min="0" value={edits.amount} onChange={(e) => set("amount", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Frequency</Label>
            <Select value={edits.frequency} onValueChange={(v) => set("frequency", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCIES.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Due day</Label>
            <Input type="number" min="1" max="31" value={edits.dueDay} onChange={(e) => set("dueDay", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Paying account</Label>
            <Select
              value={edits.paymentAccountId != null ? String(edits.paymentAccountId) : "none"}
              onValueChange={(v) => set("paymentAccountId", v === "none" ? null : Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No linked account</SelectItem>
                {(accounts ?? []).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.accountName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Matches charges from</Label>
            <MerchantPicker
              accountId={edits.paymentAccountId}
              value={edits.matchMerchant}
              onChange={(m) => set("matchMerchant", m)}
              data-testid={`merchant-picker-${draft.id}`}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

export default function BillDrafts() {
  const { data: liveDrafts, isLoading } = useListDetectedBillDrafts();
  // Snapshot the list on first load: the server excludes confirmed/dismissed
  // rows, so rendering from the live query would yank cards away mid-review.
  // Cards stay visible with their outcome; only the Bills-page badge tracks
  // the live count.
  const [snapshot, setSnapshot] = useState<DetectedBillDraft[] | null>(null);
  const drafts = snapshot ?? liveDrafts;
  if (snapshot === null && liveDrafts !== undefined) setSnapshot(liveDrafts);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { sync: syncForecast } = useSyncForecast();
  // Session-local review state: keep every card visible (with its outcome)
  // instead of letting the list shrink out from under the user.
  const [reviewed, setReviewed] = useState<Map<number, "confirmed" | "dismissed">>(new Map());
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [confirmingAll, setConfirmingAll] = useState(false);

  const confirmMutation = useConfirmDetectedBill();
  const dismissMutation = useDismissDetectedBill();

  // Opening the review page marks pending detections as seen so the login
  // "new bill detected" notice stops re-firing. The drafts snapshot was taken
  // before this runs, so "New" tags stay visible for this visit.
  const markSeenMutation = useMarkDetectedBillsSeen();
  const markedSeen = useRef(false);
  useEffect(() => {
    // Wait for the drafts to load first: the snapshot (with its isNew flags)
    // must be captured before the server clears seen state, or a slow fetch
    // could race mark-seen and lose the "New" tags on first visit.
    if (markedSeen.current || liveDrafts === undefined) return;
    markedSeen.current = true;
    markSeenMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDetectedNewBillCountQueryKey() });
        // Refresh the cached drafts so a later visit doesn't snapshot stale
        // isNew flags; this visit renders from the snapshot, so tags stay put.
        queryClient.invalidateQueries({ queryKey: getListDetectedBillDraftsQueryKey() });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveDrafts]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDetectedBillsQueryKey() });
    // Keep the Bills-page badge count in sync; this page renders from the
    // snapshot, so the refetch won't yank cards away mid-review.
    queryClient.invalidateQueries({ queryKey: getListDetectedBillDraftsQueryKey() });
  };

  const markBusy = (id: number, busy: boolean) =>
    setBusyIds((s) => {
      const next = new Set(s);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const confirmOne = async (draft: DetectedBillDraft, overrides: ConfirmDetectedBillInput) => {
    markBusy(draft.id, true);
    try {
      await confirmMutation.mutateAsync({ id: draft.id, data: overrides });
      setReviewed((m) => new Map(m).set(draft.id, "confirmed"));
      toast({ title: "Bill confirmed", description: `${overrides.billName ?? draft.displayName} is now tracked and linked.` });
      invalidateAll();
      syncForecast();
      return true;
    } catch (err) {
      toast({
        title: "Couldn't confirm",
        description: err instanceof Error ? err.message : "Something went wrong. Refresh and retry.",
        variant: "destructive",
      });
      return false;
    } finally {
      markBusy(draft.id, false);
    }
  };

  const dismissOne = async (draft: DetectedBillDraft) => {
    markBusy(draft.id, true);
    try {
      await dismissMutation.mutateAsync({ id: draft.id });
      setReviewed((m) => new Map(m).set(draft.id, "dismissed"));
      queryClient.invalidateQueries({ queryKey: getListDetectedBillDraftsQueryKey() });
    } catch (err) {
      toast({
        title: "Couldn't dismiss",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      markBusy(draft.id, false);
    }
  };

  const confirmAll = async () => {
    if (!drafts) return;
    setConfirmingAll(true);
    let ok = 0;
    for (const draft of drafts) {
      if (draft.status === "duplicate" || reviewed.has(draft.id)) continue;
      if (await confirmOne(draft, {})) ok++;
    }
    setConfirmingAll(false);
    if (ok > 0) toast({ title: "All set", description: `${ok} bill${ok === 1 ? "" : "s"} confirmed and linked.` });
  };

  const total = drafts?.length ?? 0;
  const reviewedCount = useMemo(
    () => (drafts ?? []).filter((d) => reviewed.has(d.id)).length,
    [drafts, reviewed],
  );
  const confirmable = (drafts ?? []).filter((d) => d.status !== "duplicate" && !reviewed.has(d.id));
  const done = total > 0 && reviewedCount === total;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link href="/bills" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to bills
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Sparkles className="h-6 w-6" /> We found these recurring bills
        </h1>
        <p className="text-muted-foreground">
          Each one is pre-filled and pre-linked from your transactions. Confirm, edit, or dismiss — nothing is added
          without you.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={<Check className="h-8 w-8" />}
          title="Nothing to review"
          description="No pending detections right now. Connect an account or sync transactions to find recurring bills."
        />
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span data-testid="text-progress">
                  {reviewedCount} of {total} reviewed
                </span>
                {done && <span className="font-medium text-emerald-600">Done!</span>}
              </div>
              <Progress value={total ? (reviewedCount / total) * 100 : 0} />
            </div>
            {confirmable.length > 1 && (
              <Button
                variant="outline"
                disabled={confirmingAll || busyIds.size > 0}
                onClick={confirmAll}
                data-testid="button-confirm-all"
              >
                <CheckCheck className="mr-2 h-4 w-4" />
                {confirmingAll ? "Confirming…" : `Confirm all (${confirmable.length})`}
              </Button>
            )}
          </div>

          <div className="space-y-3">
            {(drafts ?? []).map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                state={reviewed.get(draft.id) ?? "pending"}
                busy={busyIds.has(draft.id) || confirmingAll}
                onConfirm={(overrides) => void confirmOne(draft, overrides)}
                onDismiss={() => void dismissOne(draft)}
              />
            ))}
          </div>

          {done && (
            <div className="flex justify-end">
              <Button
                asChild
                onClick={() => queryClient.invalidateQueries({ queryKey: getListDetectedBillDraftsQueryKey() })}
              >
                <Link href="/bills">Go to bills</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
