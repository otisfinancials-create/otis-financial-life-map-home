import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { Sparkles, Check, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useDetectPaySchedules,
  useListDetectedPaySchedules,
  useConfirmDetectedPaySchedule,
  useDismissDetectedPaySchedule,
  getListDetectedPaySchedulesQueryKey,
  getListPaySchedulesQueryKey,
} from "@workspace/api-client-react";
import type { DetectedPaySchedule } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  "semi-monthly": "Semi-monthly (1st & 15th)",
  monthly: "Monthly",
};

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function fmtDate(iso: string | null | undefined) {
  return iso ? format(new Date(iso + "T00:00:00"), "MMM d, yyyy") : "—";
}

/** First-run pay detection: scans transaction history once per visit, proposes
 *  schedules, and requires explicit confirmation — mirrors the Bills flow. */
export function DetectedPayProposals({ hasSchedules }: { hasSchedules: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { sync: syncForecast } = useSyncForecast();

  const detect = useDetectPaySchedules();
  const ranRef = useRef(false);
  const [detectionDone, setDetectionDone] = useState(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    detect.mutate(undefined, {
      onSettled: () => {
        setDetectionDone(true);
        queryClient.invalidateQueries({ queryKey: getListDetectedPaySchedulesQueryKey() });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: proposals } = useListDetectedPaySchedules({
    query: { queryKey: getListDetectedPaySchedulesQueryKey(), enabled: detectionDone },
  });
  const confirm = useConfirmDetectedPaySchedule();
  const dismiss = useDismissDetectedPaySchedule();
  const [chosenFrequency, setChosenFrequency] = useState<Record<number, string>>({});

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListDetectedPaySchedulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPaySchedulesQueryKey() });
  };

  const handleConfirm = (p: DetectedPaySchedule) => {
    const frequency = p.cadenceAmbiguous ? chosenFrequency[p.id] : undefined;
    if (p.cadenceAmbiguous && !frequency) {
      toast({ title: "Pick a pay frequency first", description: "We couldn't tell these cadences apart from the data." });
      return;
    }
    confirm.mutate(
      { id: p.id, data: frequency ? { frequency } : {} },
      {
        onSuccess: () => {
          toast({ title: `${p.displayName} added`, description: "Forecast is syncing in the background." });
          refresh();
          syncForecast();
        },
        onError: () => toast({ title: "Failed to confirm", variant: "destructive" }),
      },
    );
  };

  const handleDismiss = (p: DetectedPaySchedule) => {
    dismiss.mutate(
      { id: p.id },
      {
        onSuccess: () => {
          toast({ title: "Dismissed", description: "This won't be suggested again." });
          refresh();
        },
        onError: () => toast({ title: "Failed to dismiss", variant: "destructive" }),
      },
    );
  };

  if (!detectionDone) return null;

  if (!proposals || proposals.length === 0) {
    // Empty state only matters when the user has no schedules yet (2e).
    if (hasSchedules) return null;
    return (
      <Card className="border-card-border bg-card rounded-xl p-6" data-testid="pay-detection-empty">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-muted-foreground mt-0.5" />
          <div>
            <p className="font-medium">No recurring pay found</p>
            <p className="text-sm text-muted-foreground mt-1">
              We look for recurring deposits from an employer in your connected accounts.
              None stood out — add your income manually below.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-card-border bg-card rounded-xl p-6 space-y-4" data-testid="pay-detection-proposals">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h2 className="font-semibold">We found recurring pay in your accounts</h2>
        <Badge variant="secondary">{proposals.length}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Confirm the ones that are real income — nothing is added until you do.
      </p>
      <div className="space-y-3">
        {proposals.map((p) => (
          <div
            key={p.id}
            className="border border-border rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            data-testid={`pay-proposal-${p.id}`}
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{p.displayName}</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {p.cadenceAmbiguous
                  ? "Cadence unclear — pick below"
                  : (FREQUENCY_LABELS[p.frequency] ?? p.frequency)}
                {" · "}latest {usd(p.amount)}
                {p.amountMin != null && p.amountMax != null && p.amountMin !== p.amountMax && (
                  <> · ranged {usd(p.amountMin)}–{usd(p.amountMax)}</>
                )}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {p.occurrenceCount} deposits, {fmtDate(p.firstSeen)} – {fmtDate(p.lastSeen)}
              </p>
              {p.cadenceAmbiguous && (
                <div className="mt-2">
                  <Select
                    value={chosenFrequency[p.id] ?? ""}
                    onValueChange={(v) => setChosenFrequency((s) => ({ ...s, [p.id]: v }))}
                  >
                    <SelectTrigger className="w-56" data-testid={`pay-proposal-${p.id}-frequency`}>
                      <SelectValue placeholder="Choose pay frequency" />
                    </SelectTrigger>
                    <SelectContent>
                      {(p.frequencyOptions.length ? p.frequencyOptions : ["biweekly", "semi-monthly"]).map((f) => (
                        <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f] ?? f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                onClick={() => handleConfirm(p)}
                disabled={confirm.isPending}
                data-testid={`pay-proposal-${p.id}-confirm`}
              >
                <Check className="h-4 w-4 mr-1" />
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleDismiss(p)}
                disabled={dismiss.isPending}
                data-testid={`pay-proposal-${p.id}-dismiss`}
              >
                <X className="h-4 w-4 mr-1" />
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
