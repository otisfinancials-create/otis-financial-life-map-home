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

  const eventDateOf = (e: LifeEvent) => e.eventDate || e.startDate || "";

  const mustDoEvents = useMemo(
    () =>
      (events ?? [])
        .filter((e) => e.priority === "must_do")
        .sort((a, b) => eventDateOf(a).localeCompare(eventDateOf(b))),
    [events],
  );

  const somedayEvents = useMemo(
    () =>
      (events ?? [])
        .filter((e) => e.priority === "planning_to" || e.priority === "just_dreaming")
        .sort((a, b) => eventDateOf(a).localeCompare(eventDateOf(b))),
    [events],
  );

  function renderCard(ev: LifeEvent) {
    const priority = PRIORITY_MAP[ev.priority];
    return (
      <Card key={ev.id} className={`${cardChrome} group ${ev.isActive ? "" : "opacity-60"}`}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="shrink-0 mt-0.5" style={{ fontSize: "16px", lineHeight: 1 }} aria-hidden="true">
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

          {ev.notes && <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{ev.notes}</p>}
        </CardContent>
      </Card>
    );
  }

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

      {/* Two-column priority layout */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {[1, 2].map((col) => (
            <div key={col} className="space-y-3">
              <Skeleton className="h-6 w-32" />
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          ))}
        </div>
      ) : mustDoEvents.length === 0 && somedayEvents.length === 0 ? (
        <EmptyState
          icon={<CalendarHeart className="h-8 w-8" />}
          title="No life events yet"
          description="Add a milestone like a vacation, home project, or new pet and we'll fold its cost into your forecast."
          className="mt-8"
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#ef4444" }} />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Must Do</h2>
              <span className="text-xs text-muted-foreground">({mustDoEvents.length})</span>
            </div>
            {mustDoEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing marked as must-do yet.</p>
            ) : (
              <div className="space-y-3">{mustDoEvents.map(renderCard)}</div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Maybe, Someday</h2>
              <span className="text-xs text-muted-foreground">({somedayEvents.length})</span>
            </div>
            {somedayEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing on the maybe list yet.</p>
            ) : (
              <div className="space-y-3">{somedayEvents.map(renderCard)}</div>
            )}
          </div>
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
