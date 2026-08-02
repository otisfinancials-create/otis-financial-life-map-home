import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Link2, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

import {
  useCreatePlaidLinkToken,
  useExchangePlaidToken,
  useDetectBills,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
  getListDetectedBillDraftsQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { ForecastAccountsDialog, type LinkedAccountOption } from "@/components/accounts/forecast-accounts-dialog";

interface PlaidConnectButtonProps {
  /**
   * Called after a link that added ONLY credit cards (the forecast-accounts
   * selection step is skipped for card-only institutions). Receives the new
   * account ids so the parent can prompt cycle-day setup for any card the
   * Liabilities sync couldn't auto-configure.
   */
  onLinkedCardsNeedSetup?: (accountIds: number[]) => void;
}

export function PlaidConnectButton({ onLinkedCardsNeedSetup }: PlaidConnectButtonProps = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ itemId: number; accounts: LinkedAccountOption[] } | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createLinkToken = useCreatePlaidLinkToken();
  const exchangeToken = useExchangePlaidToken();
  const detectBills = useDetectBills();
  const [, navigate] = useLocation();

  // Onboarding hook: after a bank is connected, run bill detection and — if
  // recurring bills were found — offer the draft review page in one click.
  const runDetection = useCallback(() => {
    detectBills.mutate(undefined, {
      onSuccess: (summary) => {
        queryClient.invalidateQueries({ queryKey: getListDetectedBillDraftsQueryKey() });
        const found = summary.pending + summary.duplicates;
        if (found > 0) {
          toast({
            title: "We found recurring bills",
            description: `${found} detected from your transactions — review and confirm them.`,
            action: (
              <ToastAction altText="Review detected bills" onClick={() => navigate("/bills/review")}>
                Review
              </ToastAction>
            ),
          });
        }
      },
      // Detection is a bonus step — a failure here shouldn't mar the
      // successful bank connection, so stay quiet and let the Bills page
      // badge pick it up later.
      onError: () => {},
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, navigate, toast]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  }, [queryClient]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      setLinkToken(null);
      exchangeToken.mutate(
        {
          data: {
            publicToken,
            institutionId: metadata.institution?.institution_id ?? null,
            institutionName: metadata.institution?.name ?? null,
          },
        },
        {
          onSuccess: (result) => {
            invalidate();
            toast({
              title: `Connected to ${result.institutionName}`,
              description:
                result.accountsAdded > 0
                  ? `${result.accountsAdded} account${result.accountsAdded === 1 ? "" : "s"} imported.`
                  : "Your accounts are up to date.",
            });
            // Selection step: which accounts do you pay bills from? Credit
            // cards are excluded inside the dialog; if the bank returned only
            // cards there is nothing to ask.
            if (result.accounts.some((a) => a.accountType !== "credit_card")) {
              setSelection({ itemId: result.itemId, accounts: result.accounts });
            } else if (result.accounts.length > 0) {
              // Card-only institution: no forecast-account selection applies,
              // but the cards may still need statement/due-day setup to show
              // up in the forecast. Let the parent take over.
              onLinkedCardsNeedSetup?.(result.accounts.map((a) => a.id));
            }
            runDetection();
          },
          onError: () => {
            toast({
              title: "Connection failed",
              description: "We couldn't finish linking your bank. Please try again.",
              variant: "destructive",
            });
          },
        },
      );
    },
    onExit: (err) => {
      setLinkToken(null);
      if (err) {
        toast({
          title: "Bank connection canceled",
          description: err.display_message ?? "Something went wrong with the bank connection.",
          variant: "destructive",
        });
      }
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const handleClick = () => {
    createLinkToken.mutate({ data: {} }, {
      onSuccess: (result) => setLinkToken(result.linkToken),
      onError: () =>
        toast({
          title: "Couldn't start bank connection",
          description: "Plaid is unavailable right now. Please try again shortly.",
          variant: "destructive",
        }),
    });
  };

  const busy = createLinkToken.isPending || exchangeToken.isPending || (linkToken != null && !ready);

  return (
    <>
      <Button variant="outline" onClick={handleClick} disabled={busy}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
        {exchangeToken.isPending ? "Importing accounts..." : busy ? "Connecting..." : "Connect Bank Account"}
      </Button>
      {selection && (
        <ForecastAccountsDialog
          itemId={selection.itemId}
          accounts={selection.accounts}
          onClose={() => setSelection(null)}
        />
      )}
    </>
  );
}
