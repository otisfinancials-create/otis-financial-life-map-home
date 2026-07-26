import { useMemo, useState } from "react";
import { Link2, Check, ArrowLeft, PencilLine, SkipForward } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import {
  useGetBillLinkReview,
  useLinkBillMerchant,
  getGetBillLinkReviewQueryKey,
  getListBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { BillLinkReviewItem, BillLinkCandidate } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { FormatCurrency } from "@/components/ui/format-currency";
import { useToast } from "@/hooks/use-toast";

function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
}: {
  candidate: BillLinkCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
      }`}
      data-testid={`candidate-${candidate.merchant.replace(/\s+/g, "-")}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{candidate.displayName}</span>
        <Badge variant="secondary">
          {candidate.occurrences} charge{candidate.occurrences === 1 ? "" : "s"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Looks like this matches:{" "}
        {candidate.samples
          .map((s) => `$${s.amount.toFixed(2)} on ${formatShortDate(s.date)}`)
          .join(", ")}
      </p>
    </button>
  );
}

function BillRow({
  item,
  linked,
  skipped,
  onLinked,
  onSkip,
}: {
  item: BillLinkReviewItem;
  linked: boolean;
  skipped: boolean;
  onLinked: () => void;
  onSkip: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(item.candidates[0]?.merchant ?? null);
  const [manualMode, setManualMode] = useState(item.candidates.length === 0);
  const [manualValue, setManualValue] = useState("");

  const linkMutation = useLinkBillMerchant({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Bill linked", description: `${item.bill.billName} will now match its charges.` });
        onLinked();
      },
      onError: () => {
        toast({
          title: "Could not link bill",
          description: "The merchant was not saved. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const confirm = () => {
    const merchant = manualMode ? manualValue.trim() : selected;
    if (!merchant) return;
    linkMutation.mutate({ id: item.bill.id, data: { matchMerchant: merchant } });
  };

  const cadence = item.bill.frequency;

  return (
    <Card className={`p-4 ${linked || skipped ? "opacity-60" : ""}`} data-testid={`link-row-${item.bill.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{item.bill.billName}</span>
            {linked && (
              <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                <Check className="mr-1 h-3 w-3" /> Linked
              </Badge>
            )}
            {skipped && <Badge variant="outline">Skipped</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            <FormatCurrency amount={item.bill.amount} /> · {cadence} · paid from {item.accountName}
          </p>
        </div>
        {!linked && !skipped && (
          <div className="flex items-center gap-2">
            {item.candidates.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setManualMode((m) => !m)}
                data-testid={`button-manual-${item.bill.id}`}
              >
                <PencilLine className="mr-1 h-4 w-4" />
                {manualMode ? "Use suggestions" : "Enter manually"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onSkip} data-testid={`button-skip-${item.bill.id}`}>
              <SkipForward className="mr-1 h-4 w-4" /> Skip
            </Button>
          </div>
        )}
      </div>

      {!linked && !skipped && (
        <div className="mt-3 space-y-2">
          {manualMode ? (
            <div className="flex gap-2">
              <Input
                placeholder="Merchant name as it appears on the statement (e.g. AT&T MOBILITY)"
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                data-testid={`input-manual-${item.bill.id}`}
              />
              <Button
                onClick={confirm}
                disabled={!manualValue.trim() || linkMutation.isPending}
                data-testid={`button-confirm-${item.bill.id}`}
              >
                {linkMutation.isPending ? "Linking…" : "Link"}
              </Button>
            </div>
          ) : (
            <>
              {item.candidates.map((c) => (
                <CandidateCard
                  key={c.merchant}
                  candidate={c}
                  selected={selected === c.merchant}
                  onSelect={() => setSelected(c.merchant)}
                />
              ))}
              <Button
                onClick={confirm}
                disabled={!selected || linkMutation.isPending}
                data-testid={`button-confirm-${item.bill.id}`}
              >
                <Check className="mr-1 h-4 w-4" />
                {linkMutation.isPending ? "Linking…" : "Confirm match"}
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default function LinkBills() {
  const { data: items, isLoading } = useGetBillLinkReview();
  const queryClient = useQueryClient();
  const [linkedIds, setLinkedIds] = useState<Set<number>>(new Set());
  const [skippedIds, setSkippedIds] = useState<Set<number>>(new Set());

  // Keep the original list stable while the user works through it (the
  // server list shrinks as bills get linked; re-fetching mid-review would
  // make rows vanish before the user sees the "Linked" state).
  const total = items?.length ?? 0;
  const linkedCount = linkedIds.size;

  const sorted = useMemo(() => {
    if (!items) return [];
    // Bills with suggestions first — those are one click away.
    return [...items].sort((a, b) => (b.candidates.length > 0 ? 1 : 0) - (a.candidates.length > 0 ? 1 : 0));
  }, [items]);

  const done = total > 0 && linkedCount + skippedIds.size === total;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link href="/bills" className="mb-2 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to bills
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Link2 className="h-6 w-6" /> Link your bills
        </h1>
        <p className="text-muted-foreground">
          Match each bill to its real merchant so charges land on the bill line instead of Misc.
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
          title="All bills are linked"
          description="Every bill that pays from an account already knows its merchant."
        />
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span data-testid="text-progress">
                {linkedCount} of {total} linked
                {skippedIds.size > 0 ? ` · ${skippedIds.size} skipped` : ""}
              </span>
              {done && <span className="font-medium text-emerald-600">Done!</span>}
            </div>
            <Progress value={total ? (linkedCount / total) * 100 : 0} />
          </div>

          <div className="space-y-3">
            {sorted.map((item) => (
              <BillRow
                key={item.bill.id}
                item={item}
                linked={linkedIds.has(item.bill.id)}
                skipped={skippedIds.has(item.bill.id)}
                onLinked={() => setLinkedIds((s) => new Set(s).add(item.bill.id))}
                onSkip={() => setSkippedIds((s) => new Set(s).add(item.bill.id))}
              />
            ))}
          </div>

          {done && (
            <Button
              className="w-full"
              onClick={() => queryClient.invalidateQueries({ queryKey: getGetBillLinkReviewQueryKey() })}
              asChild
            >
              <Link href="/bills">Finish and go to bills</Link>
            </Button>
          )}
        </>
      )}
    </div>
  );
}
