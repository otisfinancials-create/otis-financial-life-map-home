import { useMemo, useState } from "react";
import { CalendarHeart, Plus, Pencil, Trash2, CalendarRange } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListLifeEvents,
  useDeleteLifeEvent,
  getListLifeEventsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { LifeEvent } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LifeEventDialog } from "@/components/life-events/life-event-dialog";
import {
  LIFE_EVENT_CATEGORIES,
  categoryLabel,
  PRIORITY_MAP,
  TIMING_LABELS,
  FREQUENCY_LABELS,
} from "@/components/life-events/constants";
import { getCategoryEmoji } from "@/utils/categoryIcons";

const cardChrome = "rounded-xl border border-border bg-card shadow-sm";

function fmtDate(d?: string | null): string {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function timingSummary(ev: LifeEvent): string {
  if (ev.timingType === "one_time") return `One-time · ${fmtDate(ev.eventDate)}`;
  if (ev.timingType === "spread") return `Spread · ${fmtDate(ev.startDate)} – ${fmtDate(ev.endDate)}`;
  const freq = FREQUENCY_LABELS[ev.frequency ?? ""] ?? "Recurring";
  return `${freq} · from ${fmtDate(ev.startDate)}${ev.endDate ? ` – ${fmtDate(ev.endDate)}` : ""}`;
}

export default function LifeEvents() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: events, isLoading } = useListLifeEvents();
  const deleteEvent = useDeleteLifeEvent();
  const { sync: syncForecast } = useSyncForecast();

  const [eventToEdit, setEventToEdit] = useState<LifeEvent | undefined>(undefined);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [eventToDelete, setEventToDelete] = useState<LifeEvent | undefined>(undefined);

  const active = useMemo(() => (events ?? []).filter((e) => e.isActive), [events]);

  const totalPlanned = active.reduce((s, e) => s + e.amount, 0);
  const mustDoTotal = active.filter((e) => e.priority === "must_do").reduce((s, e) => s + e.amount, 0);

  const nextEvent = useMemo(() => {
    const todayStr = new Date().toISOString().split("T")[0];
    return active
      .map((e) => ({ e, date: e.eventDate || e.startDate || "" }))
      .filter((x) => x.date && x.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))[0]?.e;
  }, [active]);

  const grouped = useMemo(() => {
    const byCat: Record<string, LifeEvent[]> = {};
    for (const e of events ?? []) {
      (byCat[e.category] ??= []).push(e);
    }
    return LIFE_EVENT_CATEGORIES.map((c) => ({ cat: c, items: byCat[c.value] ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [events]);

  function handleDelete() {
    if (!eventToDelete) return;
    deleteEvent.mutate(
      { id: eventToDelete.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListLifeEventsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Life event removed", description: "Forecast is syncing in the background." });
          setEventToDelete(undefined);
          syncForecast();
        },
        onError: () => toast({ title: "Failed to remove life event", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Life Events</h1>
          <p className="text-muted-foreground mt-1">Plan for the big moments and see them in your forecast.</p>
        </div>
        <LifeEventDialog
          trigger={
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Life Event
            </Button>
          }
        />
      </div>

      {/* Summary panel */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className={cardChrome} style={{ borderLeft: "3px solid #14b8a6" }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Planned</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-9 w-32" />
            ) : (
              <>
                <div className="text-3xl font-bold font-mono tabular-nums tracking-tight">
                  <FormatCurrency amount={totalPlanned} />
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">{active.length} active event{active.length === 1 ? "" : "s"}</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className={cardChrome} style={{ borderLeft: "3px solid #ef4444" }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Must-Do Commitments</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-9 w-32" />
            ) : (
              <>
                <div className="text-3xl font-bold font-mono tabular-nums tracking-tight">
                  <FormatCurrency amount={mustDoTotal} />
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">Highest-priority spending</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className={cardChrome} style={{ borderLeft: "3px solid #3b82f6" }}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Next Up</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-9 w-40" />
            ) : nextEvent ? (
              <>
                <div className="text-xl font-bold tracking-tight truncate">{nextEvent.eventName}</div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {fmtDate(nextEvent.eventDate || nextEvent.startDate)} · <FormatCurrency amount={nextEvent.amount} />
                </p>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Nothing on the horizon yet.</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Events grouped by category */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart className="h-8 w-8" />}
          title="No life events yet"
          description="Add a milestone like a vacation, home project, or new pet and we'll fold its cost into your forecast."
          className="mt-8"
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(({ cat, items }) => {
            const catTotal = items.filter((e) => e.isActive).reduce((s, e) => s + e.amount, 0);
            return (
              <div key={cat.value}>
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-md"
                    style={{ backgroundColor: cat.bg, fontSize: "16px", lineHeight: 1 }}
                  >
                    {getCategoryEmoji(cat.label)}
                  </span>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    {cat.label}
                  </h2>
                  <span className="text-xs text-muted-foreground font-mono">
                    <FormatCurrency amount={catTotal} />
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((ev) => {
                    const priority = PRIORITY_MAP[ev.priority];
                    return (
                      <Card
                        key={ev.id}
                        className={`${cardChrome} group ${ev.isActive ? "" : "opacity-60"}`}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2 min-w-0">
                              <span
                                className="shrink-0 mt-0.5"
                                style={{ fontSize: "16px", lineHeight: 1 }}
                                aria-hidden="true"
                              >
                                {getCategoryEmoji(categoryLabel(ev.category, ev.customCategory), ev.eventName)}
                              </span>
                              <div className="min-w-0">
                                <p className="font-semibold truncate">{ev.eventName}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {categoryLabel(ev.category, ev.customCategory)}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={() => {
                                  setEventToEdit(ev);
                                  setIsEditOpen(true);
                                }}
                                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setEventToDelete(ev)}
                                className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="mt-3 text-2xl font-bold font-mono tabular-nums tracking-tight">
                            <FormatCurrency amount={ev.amount} />
                          </div>

                          <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                            <CalendarRange className="h-3 w-3 shrink-0" />
                            <span className="truncate">{timingSummary(ev)}</span>
                          </p>

                          <div className="mt-3 flex items-center gap-2">
                            {priority && (
                              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${priority.badgeClass}`}>
                                {priority.label}
                              </span>
                            )}
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                              {TIMING_LABELS[ev.timingType] ?? ev.timingType}
                            </span>
                          </div>

                          {ev.notes && (
                            <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{ev.notes}</p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit dialog (controlled) */}
      <LifeEventDialog event={eventToEdit} open={isEditOpen} onOpenChange={setIsEditOpen} />

      {/* Delete confirmation */}
      <AlertDialog open={!!eventToDelete} onOpenChange={(o) => !o && setEventToDelete(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this life event?</AlertDialogTitle>
            <AlertDialogDescription>
              {eventToDelete
                ? `"${eventToDelete.eventName}" will be removed from your plan and forecast. This can't be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
