import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightSmall, Loader2 } from "lucide-react";
import {
  useGetForecastCalendar,
  getGetForecastCalendarQueryKey,
  useGetCycleBreakdown,
  getGetCycleBreakdownQueryKey,
} from "@workspace/api-client-react";
import type { ForecastCalendarDay, ForecastCalendarEvent } from "@workspace/api-client-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

const fmt = (n: number) => {
  const rounded = Math.round(Math.abs(n));
  return `${n < 0 ? "−" : ""}$${rounded.toLocaleString()}`;
};
const fmtSigned = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

function netColor(net: number): string {
  if (Math.round(net) === 0) return "text-muted-foreground/50";
  return net > 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]";
}

// ─── card payment composition (read-only P5 breakdown) ──────────────────────

function CardPaymentComposition({ cycleId }: { cycleId: number }) {
  const { data, isLoading } = useGetCycleBreakdown(cycleId, {
    query: { queryKey: getGetCycleBreakdownQueryKey(cycleId) },
  });
  if (isLoading)
    return (
      <div className="pl-7 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading composition…
      </div>
    );
  if (!data) return null;
  const envelopes = data.envelopes ?? [];
  const bills = data.bills ?? [];
  return (
    <div className="pl-7 pb-2 space-y-0.5">
      {bills.map((b) => (
        <div key={`b-${b.id}`} className="flex items-center justify-between text-xs py-0.5">
          <span className="text-muted-foreground truncate">{b.billName}</span>
          <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
            {fmt(-(b.actualAmount ?? b.expectedAmount ?? 0))}
          </span>
        </div>
      ))}
      {envelopes.map((e) => (
        <div key={`e-${e.id}`} className="flex items-center justify-between text-xs py-0.5">
          <span className="text-muted-foreground truncate">{e.name}</span>
          <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
            {fmt(-Math.max(e.spentAmount ?? 0, e.plannedAmount ?? 0))}
          </span>
        </div>
      ))}
      {bills.length === 0 && envelopes.length === 0 && (
        <div className="text-xs text-muted-foreground py-0.5">No composition yet for this cycle</div>
      )}
    </div>
  );
}

// ─── detail panel ────────────────────────────────────────────────────────────

const KIND_LABEL: Record<ForecastCalendarEvent["kind"], string> = {
  income: "Income",
  bill: "Bill",
  "card-payment": "Card payment",
  spend: "Spending",
  "balance-update": "Balance update",
  other: "Planned",
};

function DayDetail({ day, todayStr }: { day: ForecastCalendarDay; todayStr: string }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const tag = day.date === todayStr ? "Today" : day.date < todayStr ? "Actual" : "Planned";
  const tagStyle =
    tag === "Today"
      ? "bg-[var(--color-carolina-light)] text-[var(--color-carolina)]"
      : tag === "Actual"
        ? "bg-[#F1F3F6] text-gray-500"
        : "bg-[#EEF6EE] text-[var(--color-positive)]";

  const events = day.events.filter((e) => e.kind !== "balance-update");
  const balanceUpdates = day.events.filter((e) => e.kind === "balance-update");

  return (
    <div className="bg-white border border-[#E8ECF0] rounded-[14px] mt-3" data-testid="calendar-day-detail">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#F0F2F5]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-navy)]">{dayLabel(day.date)}</span>
          <span className={`rounded-full text-[10px] font-medium px-2 py-0.5 ${tagStyle}`}>{tag}</span>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">End of day</div>
          <div className="text-sm font-semibold tabular-nums text-[var(--color-navy)]" data-testid="detail-end-balance">
            {fmt(day.endBalance)}
          </div>
        </div>
      </div>

      <div className="px-4 py-2">
        {balanceUpdates.map((e, i) => (
          <div key={`bu-${i}`} className="flex items-center justify-between py-1.5 text-xs">
            <span className="text-[var(--color-carolina)] font-medium">{e.label}</span>
            <span className="tabular-nums text-[var(--color-carolina)] font-medium">{fmt(e.amount)}</span>
          </div>
        ))}
        {events.length === 0 && balanceUpdates.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {day.date < todayStr ? "No activity recorded" : "No activity planned"}
          </div>
        )}
        {events.map((e, i) => {
          const expandable = (e.kind === "card-payment" && e.cycleId != null) || (e.kind === "spend" && (e.charges?.length ?? 0) > 0);
          const isOpen = expanded.has(i);
          return (
            <div key={i} className="border-b border-[#F5F7F9] last:border-b-0">
              <button
                onClick={expandable ? () => toggle(i) : undefined}
                className={`w-full flex items-center gap-2 py-2 text-left ${expandable ? "cursor-pointer" : "cursor-default"}`}
                data-testid={`detail-event-${i}`}
              >
                {expandable ? (
                  isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRightSmall className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="rounded-full text-[10px] font-medium px-1.5 py-0.5 bg-[#F1F3F6] text-gray-500 shrink-0">
                  {KIND_LABEL[e.kind]}
                </span>
                <span className="text-sm text-foreground truncate flex-1">
                  {e.label}
                  {e.kind === "spend" && e.count ? (
                    <span className="text-muted-foreground"> ({e.count} charge{e.count === 1 ? "" : "s"})</span>
                  ) : null}
                </span>
                <span className={`text-sm tabular-nums shrink-0 font-medium ${e.amount > 0 ? "text-[var(--color-positive)]" : "text-foreground"}`}>
                  {fmtSigned(e.amount)}
                </span>
              </button>
              {isOpen && e.kind === "card-payment" && e.cycleId != null && <CardPaymentComposition cycleId={e.cycleId} />}
              {isOpen && e.kind === "spend" && (
                <div className="pl-7 pb-2 space-y-0.5">
                  {(e.charges ?? []).map((c, j) => (
                    <div key={j} className="flex items-center justify-between text-xs py-0.5">
                      <span className="text-muted-foreground truncate">{c.name}</span>
                      <span className="text-muted-foreground tabular-nums shrink-0 ml-2">{fmt(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── calendar view ───────────────────────────────────────────────────────────

export default function CalendarView({ todayStr: clientToday }: { todayStr: string }) {
  const [month, setMonth] = useState(clientToday.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(clientToday);

  const { data, isLoading } = useGetForecastCalendar(
    { month },
    { query: { queryKey: getGetForecastCalendarQueryKey({ month }) } },
  );

  // The server's `today` is the canonical past/future seam — the data is
  // split on it, so highlight/shade/tags must use it too (client clock may
  // drift across timezone boundaries).
  const todayStr = data?.today ?? clientToday;
  const currentMonth = todayStr.slice(0, 7);
  const days = data?.days ?? [];
  const dayByDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const selected = dayByDate.get(selectedDate) ?? (month === currentMonth ? dayByDate.get(todayStr) : days[0]);

  // Leading blanks so day 1 lands on its weekday.
  const leadingBlanks = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return new Date(y!, m! - 1, 1).getDay();
  }, [month]);

  const goToMonth = (next: string) => {
    setMonth(next);
    setSelectedDate(next === currentMonth ? todayStr : `${next}-01`);
  };

  return (
    <div className="max-w-4xl">
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => goToMonth(shiftMonth(month, -1))}
            className="h-7 w-7 rounded-full border border-[#E3E7ED] bg-white flex items-center justify-center text-gray-500 hover:text-gray-800 hover:border-gray-300"
            data-testid="calendar-prev-month"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => goToMonth(shiftMonth(month, 1))}
            className="h-7 w-7 rounded-full border border-[#E3E7ED] bg-white flex items-center justify-center text-gray-500 hover:text-gray-800 hover:border-gray-300"
            data-testid="calendar-next-month"
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <h2 className="text-base font-semibold text-[var(--color-navy)] ml-2" data-testid="calendar-month-label">
            {monthLabel(month)}
          </h2>
        </div>
        {month !== currentMonth && (
          <button
            onClick={() => goToMonth(currentMonth)}
            className="rounded-[20px] px-[13px] py-[4px] text-xs font-medium bg-white border border-[#E3E7ED] text-gray-500 hover:text-gray-800 hover:border-gray-300"
            data-testid="calendar-today-button"
          >
            Today
          </button>
        )}
      </div>

      {/* Grid */}
      <div className="bg-white border border-[#E8ECF0] rounded-[14px] overflow-hidden">
        <div className="grid grid-cols-7 border-b border-[#F0F2F5]">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {w}
            </div>
          ))}
        </div>
        {isLoading ? (
          <div className="py-16 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-7">
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <div key={`blank-${i}`} className="border-b border-r border-[#F5F7F9] min-h-[68px]" />
            ))}
            {days.map((d) => {
              const isPast = d.date < todayStr;
              const isToday = d.date === todayStr;
              const isSelected = selected?.date === d.date;
              return (
                <button
                  key={d.date}
                  onClick={() => setSelectedDate(d.date)}
                  className={`relative border-b border-r border-[#F5F7F9] min-h-[68px] px-1.5 py-1 text-left align-top transition-colors
                    ${isPast ? "bg-[var(--color-surface)]" : "bg-white"}
                    ${isSelected ? "ring-2 ring-inset ring-[var(--color-carolina)]" : "hover:bg-[#FAFBFC]"}`}
                  data-testid={`calendar-day-${d.date}`}
                >
                  <span
                    className={`inline-flex items-center justify-center text-[11px] font-medium h-5 min-w-5 px-0.5 rounded-full
                      ${isToday ? "text-white" : "text-gray-500"}`}
                    style={isToday ? { backgroundColor: "var(--color-carolina)" } : undefined}
                  >
                    {Number(d.date.slice(8, 10))}
                  </span>
                  <div className={`text-[11px] font-medium tabular-nums leading-tight mt-0.5 ${netColor(d.net)}`}>
                    {Math.round(d.net) === 0 ? "—" : fmtSigned(d.net)}
                  </div>
                  <div className="text-[10px] tabular-nums text-muted-foreground leading-tight">{fmt(d.endBalance)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && <DayDetail key={selected.date} day={selected} todayStr={todayStr} />}
    </div>
  );
}
