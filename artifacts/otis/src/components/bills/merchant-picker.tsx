import { useState } from "react";
import { Check, ChevronsUpDown, ListFilter } from "lucide-react";

import { useListAccountMerchants, getListAccountMerchantsQueryKey } from "@workspace/api-client-react";
import type { AccountMerchant } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface MerchantPickerProps {
  /** Paying account whose real merchants populate the picker. */
  accountId?: number | null;
  /** Current match_merchant value (normalized string, or ""). */
  value: string;
  onChange: (merchant: string) => void;
  placeholder?: string;
  "data-testid"?: string;
}

/**
 * Searchable picker of REAL merchants from the paying account's posted
 * charges — selecting stores the exact normalized merchant string, so the
 * value always matches a real transaction. Free text is only offered as a
 * clearly-marked last resort when the account has no synced merchants (a
 * manual card) or the charge hasn't posted yet.
 */
export function MerchantPicker({ accountId, value, onChange, placeholder, ...rest }: MerchantPickerProps) {
  const [open, setOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);

  const enabled = accountId != null && accountId > 0;
  const { data: merchants, isLoading } = useListAccountMerchants(
    { accountId: accountId ?? 0 },
    { query: { queryKey: getListAccountMerchantsQueryKey({ accountId: accountId ?? 0 }), enabled } },
  );

  const loadedMerchants = Array.isArray(merchants) ? merchants : undefined;
  const hasMerchants = (loadedMerchants?.length ?? 0) > 0;
  const selected = loadedMerchants?.find((m) => m.merchant === value);

  // LOADING: fetch in flight — never fall through to the list render with
  // undefined data.
  if (enabled && isLoading) {
    return (
      <Button type="button" variant="outline" disabled className="w-full justify-between font-normal">
        <span className="text-muted-foreground">Loading merchants…</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    );
  }

  // EMPTY: manual card (no synced charges), fetch error, or no paying
  // account — manual entry is the only option; flag it as such.
  if (!enabled || !hasMerchants) {
    return (
      <div className="space-y-1">
        <Input
          placeholder={placeholder ?? "Merchant name as it appears on the statement"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid={rest["data-testid"] ?? "input-merchant-manual"}
        />
        <p className="text-[11px] text-muted-foreground">
          {enabled
            ? "This account has no synced charges to pick from (manual account or nothing posted yet) — enter the merchant by hand."
            : "Select a paying account to pick from its real charges, or enter the merchant by hand."}
        </p>
      </div>
    );
  }

  if (manualMode) {
    return (
      <div className="space-y-1">
        <div className="flex gap-2">
          <Input
            placeholder="Merchant name as it appears on the statement"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            data-testid={rest["data-testid"] ?? "input-merchant-manual"}
          />
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setManualMode(false)}>
            <ListFilter className="mr-1 h-4 w-4" /> Pick instead
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Last resort — typed values only match if they exactly match a future charge's merchant.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-full justify-between font-normal"
              data-testid={rest["data-testid"] ?? "button-merchant-picker"}
            >
              <span className={cn("truncate", !value && "text-muted-foreground")}>
                {selected ? selected.displayName : value || (placeholder ?? "Pick the real merchant…")}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search merchants…" />
              <CommandList>
                <CommandEmpty>No merchant found in this account's charges.</CommandEmpty>
                <CommandGroup>
                  {(loadedMerchants ?? []).map((m: AccountMerchant) => (
                    <CommandItem
                      key={m.merchant}
                      value={`${m.merchant} ${m.displayName}`}
                      onSelect={() => {
                        onChange(m.merchant);
                        setOpen(false);
                      }}
                      data-testid={`merchant-option-${m.merchant.replace(/\s+/g, "-")}`}
                    >
                      <Check className={cn("mr-2 h-4 w-4 shrink-0", value === m.merchant ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{m.displayName}</span>
                      <span className="ml-auto pl-2 text-xs text-muted-foreground whitespace-nowrap">
                        {m.occurrences}× · ~${m.typicalAmount.toFixed(2)} · {formatShortDate(m.lastDate)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Charge hasn't posted to this account yet?{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => setManualMode(true)}
          data-testid="link-merchant-manual-fallback"
        >
          Enter it manually (last resort)
        </button>
      </p>
    </div>
  );
}
