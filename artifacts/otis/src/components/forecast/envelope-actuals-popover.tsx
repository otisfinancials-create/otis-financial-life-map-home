import { useCallback, useRef, useState } from "react";
import { format } from "date-fns";
import { AlertTriangle } from "lucide-react";

import {
  useListEnvelopeAllocations,
  getListEnvelopeAllocationsQueryKey,
} from "@workspace/api-client-react";

import { FormatCurrency } from "@/components/ui/format-currency";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canHover, useOutsideTapDismiss } from "@/lib/popover-touch";

/**
 * Tap/hover breakdown of an envelope's actuals: the allocated transactions
 * that sum to the displayed number. Fetches only when opened. If the
 * allocations total disagrees with the stored spent amount, the mismatch is
 * surfaced rather than hidden.
 */
export function EnvelopeActualsPopover({
  envelopeId,
  envelopeName,
  spentAmount,
  overspent,
}: {
  envelopeId: number;
  envelopeName: string;
  spentAmount: number;
  overspent: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideTapDismiss(open, close, contentRef, triggerRef);
  const { data, isLoading, isError } = useListEnvelopeAllocations(envelopeId, {
    query: { enabled: open, queryKey: getListEnvelopeAllocationsQueryKey(envelopeId) },
  });

  const mismatch =
    data != null && Math.abs(data.allocationsTotal - data.spentAmount) >= 0.01;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          ref={triggerRef}
          aria-label={`Show transactions for ${envelopeName} actuals`}
          data-testid={`envelope-actuals-trigger-${envelopeId}`}
          className={`underline decoration-dotted underline-offset-2 font-mono tabular-nums ${
            overspent ? "text-[var(--color-negative)] font-medium" : "text-slate-600 hover:text-slate-900"
          }`}
          onMouseEnter={() => { if (canHover()) setOpen(true); }}
          onMouseLeave={() => { if (canHover()) setOpen(false); }}
        >
          <FormatCurrency amount={spentAmount} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        side="top"
        className="w-80 p-3 text-sm"
        onMouseEnter={() => { if (canHover()) setOpen(true); }}
        onMouseLeave={() => { if (canHover()) setOpen(false); }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1.5">
          {envelopeName} — transactions
        </div>
        {isLoading ? (
          <p className="text-xs text-slate-600">Loading…</p>
        ) : isError || data == null ? (
          <p className="text-xs text-slate-700">Couldn't load transactions.</p>
        ) : data.transactions.length === 0 ? (
          <p className="text-xs text-slate-700">No transactions allocated yet.</p>
        ) : (
          <>
            <ul className="max-h-56 overflow-y-auto divide-y divide-slate-100 -mx-1">
              {data.transactions.map((t, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2 px-1 py-1">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] text-slate-800">{t.name}</span>
                    <span className="block text-[10px] text-slate-600">
                      {t.txnDate ? format(new Date(t.txnDate + "T00:00:00"), "MMM d, yyyy") : "No date"}
                      {t.source === "manual" ? " · manual" : ""}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-[12px] text-slate-800 whitespace-nowrap">
                    <FormatCurrency amount={t.amount} />
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-baseline justify-between gap-2 border-t border-slate-200 mt-1 pt-1.5 px-1">
              <span className="text-[11px] font-medium text-slate-700">
                Total ({data.transactions.length})
              </span>
              <span className="font-mono tabular-nums text-[12px] font-semibold text-slate-900">
                <FormatCurrency amount={data.allocationsTotal} />
              </span>
            </div>
            {mismatch && (
              <p className="mt-1.5 flex items-start gap-1 text-[11px] text-amber-700">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>
                  These transactions total <FormatCurrency amount={data.allocationsTotal} /> but the
                  envelope shows <FormatCurrency amount={data.spentAmount} /> — the difference hasn't
                  been reconciled yet.
                </span>
              </p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
