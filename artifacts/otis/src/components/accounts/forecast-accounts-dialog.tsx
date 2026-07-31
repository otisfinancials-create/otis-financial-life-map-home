import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  useSetPlaidForecastAccounts,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export interface LinkedAccountOption {
  id: number;
  accountName: string;
  accountType: string;
  accountNumberLast4: string | null;
  isForecastAccount: boolean;
}

interface Props {
  itemId: number | null;
  accounts: LinkedAccountOption[];
  onClose: () => void;
}

/**
 * Connect-time selection step: which of the newly linked accounts does the
 * user pay bills from? Credit cards are filtered out — they can never feed
 * the forecast. Defaults: checking checked, everything else unchecked.
 */
export function ForecastAccountsDialog({ itemId, accounts, onClose }: Props) {
  const cashAccounts = accounts.filter((a) => a.accountType !== "credit_card");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const save = useSetPlaidForecastAccounts();

  useEffect(() => {
    // Server defaults checking accounts on; mirror that as the initial state.
    setSelected(new Set(cashAccounts.filter((a) => a.isForecastAccount).map((a) => a.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  if (itemId == null || cashAccounts.length === 0) return null;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = () => {
    save.mutate(
      { data: { itemId, selectedAccountIds: [...selected] } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          onClose();
        },
        onError: () => {
          toast({
            title: "Couldn't save your selection",
            description: "You can change this anytime from the Accounts page.",
            variant: "destructive",
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent data-testid="dialog-forecast-accounts">
        <DialogHeader>
          <DialogTitle>Which accounts do you pay bills from?</DialogTitle>
          <DialogDescription>
            We&apos;ll use these to track your money coming in and going out. Savings and investment accounts are tracked separately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {cashAccounts.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-3" data-testid={`row-forecast-account-${a.id}`}>
              <Checkbox
                checked={selected.has(a.id)}
                onCheckedChange={() => toggle(a.id)}
                data-testid={`checkbox-forecast-account-${a.id}`}
              />
              <span className="flex-1 text-sm font-medium">{a.accountName}</span>
              {a.accountNumberLast4 && <span className="text-xs text-muted-foreground">•••• {a.accountNumberLast4}</span>}
            </label>
          ))}
          {selected.size === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-forecast-accounts">
              Choose at least one account for your forecast — without one, we can&apos;t track your money coming in and going out. You can also do this later from the Accounts page.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleSave} disabled={save.isPending} data-testid="button-save-forecast-accounts">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
