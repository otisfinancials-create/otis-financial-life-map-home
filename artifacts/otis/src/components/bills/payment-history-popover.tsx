import { useCallback, useRef, useState } from "react";
import { format } from "date-fns";
import { History } from "lucide-react";

import type { BillPaymentStats } from "@workspace/api-client-react";

import { FormatCurrency } from "@/components/ui/format-currency";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canHover, useOutsideTapDismiss } from "@/lib/popover-touch";

/**
 * Cadence-correct unit wording. Never normalize to monthly — a quarterly
 * bill's average is stated "per quarter".
 */
function frequencyUnit(frequency: string, customIntervalDays?: number | null): string {
  if (frequency === "custom" && customIntervalDays != null) {
    return customIntervalDays === 1 ? "per day" : `every ${customIntervalDays} days`;
  }
  switch (frequency) {
    case "monthly":
      return "per month";
    case "weekly":
      return "per week";
    case "biweekly":
      return "every 2 weeks";
    case "semi-monthly":
      return "twice a month";
    case "quarterly":
      return "per quarter";
    case "semi-annual":
    case "semiannual":
    case "biannual":
      return "every 6 months";
    case "annual":
    case "annually":
    case "yearly":
      return "per year";
    default:
      return "per payment";
  }
}

function formatMonth(iso: string): string {
  return format(new Date(iso + "T00:00:00"), "MMM yyyy");
}

export function PaymentHistoryPopover({
  billName,
  stats,
}: {
  billName: string;
  stats: BillPaymentStats | undefined;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideTapDismiss(open, close, contentRef, triggerRef);

  const count = stats?.count ?? 0;
  const hasRange =
    stats != null &&
    stats.isVariable &&
    stats.minAmount != null &&
    stats.maxAmount != null &&
    stats.maxAmount - stats.minAmount >= 0.01;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          ref={triggerRef}
          aria-label={`Payment history for ${billName}`}
          data-testid={`payment-history-trigger-${stats?.billId ?? "none"}`}
          className="inline-flex items-center justify-center rounded p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => { if (canHover()) setOpen(true); }}
          onMouseLeave={() => { if (canHover()) setOpen(false); }}
        >
          <History className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        side="top"
        className="w-64 p-3 text-sm"
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => { if (canHover()) setOpen(true); }}
        onMouseLeave={() => { if (canHover()) setOpen(false); }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1.5">
          Payment history
        </div>
        {stats == null || count === 0 ? (
          <p className="text-slate-700">No payment history yet.</p>
        ) : count === 1 ? (
          <p className="text-slate-800">
            One payment so far: <span className="font-mono font-medium"><FormatCurrency amount={stats.totalPaid} /></span>
            {stats.firstDate && (
              <span className="block text-xs text-slate-600 mt-1">
                Paid {formatMonth(stats.firstDate)}
              </span>
            )}
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-slate-800">
              Average{" "}
              <span className="font-mono font-semibold">
                <FormatCurrency amount={stats.average ?? 0} />
              </span>{" "}
              {frequencyUnit(stats.frequency, stats.customIntervalDays)}
            </p>
            {hasRange && (
              <p className="text-xs text-slate-700">
                Ranges from{" "}
                <span className="font-mono"><FormatCurrency amount={stats.minAmount!} /></span> to{" "}
                <span className="font-mono"><FormatCurrency amount={stats.maxAmount!} /></span>
              </p>
            )}
            <p className="text-xs text-slate-600">
              {count} payments since {stats.firstDate ? formatMonth(stats.firstDate) : "—"}
              {stats.lastDate ? `, most recent ${formatMonth(stats.lastDate)}` : ""}.
            </p>
            <p className="text-xs text-slate-500">
              Based on payments recorded here — earlier payments may not be included.
            </p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
