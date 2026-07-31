import { useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useQueryClient } from "@tanstack/react-query";

import {
  useCreatePlaidLinkToken,
  useRefreshPlaidItemAccounts,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";

import { useToast } from "@/hooks/use-toast";
import { ForecastAccountsDialog, type LinkedAccountOption } from "@/components/accounts/forecast-accounts-dialog";

interface Props {
  /** Internal plaid_items row id — the already-connected institution. */
  itemId: number;
  institutionName: string;
  onDone: () => void;
}

/**
 * Update-mode Plaid Link flow: lets the user ADD an account under a bank
 * they've already connected, without removing and re-linking the item.
 *
 * Mounted on demand (from the "Add an account" action). Creates an
 * update-mode link token, opens Link, and on success calls the
 * refresh-accounts reconciliation endpoint — NOT the exchange-token path,
 * because update mode does not issue a new access token. If the session
 * added non-credit-card accounts, the "which accounts do you pay bills
 * from?" dialog is shown listing only the newly added accounts (all
 * unchecked by default — new accounts start with isForecastAccount=false).
 */
export function PlaidUpdateLink({ itemId, institutionName, onDone }: Props) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [selection, setSelection] = useState<LinkedAccountOption[] | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createLinkToken = useCreatePlaidLinkToken();
  const refreshAccounts = useRefreshPlaidItemAccounts();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createLinkToken.mutate(
      { data: { plaidItemId: itemId } },
      {
        onSuccess: (result) => setLinkToken(result.linkToken),
        onError: () => {
          toast({
            title: "Couldn't start the account update",
            description: "Plaid is unavailable right now. Please try again shortly.",
            variant: "destructive",
          });
          onDone();
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => {
      // Update mode: the public token is NOT exchanged (the existing access
      // token stays valid). Reconcile the item's accounts server-side.
      setLinkToken(null);
      refreshAccounts.mutate(
        { id: itemId },
        {
          onSuccess: (result) => {
            invalidate();
            toast({
              title: `${result.institutionName} updated`,
              description:
                result.accountsAdded > 0
                  ? `${result.accountsAdded} new account${result.accountsAdded === 1 ? "" : "s"} added.`
                  : "Your accounts are up to date.",
            });
            const newCash = result.newAccounts.filter((a) => a.accountType !== "credit_card");
            if (newCash.length > 0) {
              setSelection(result.newAccounts);
            } else {
              onDone();
            }
          },
          onError: () => {
            toast({
              title: "Couldn't refresh your accounts",
              description: "The bank update finished, but we couldn't import the changes. Please try again.",
              variant: "destructive",
            });
            onDone();
          },
        },
      );
    },
    onExit: (err) => {
      setLinkToken(null);
      if (err) {
        toast({
          title: "Account update canceled",
          description: err.display_message ?? "Something went wrong with the bank connection.",
          variant: "destructive",
        });
      }
      if (!refreshAccounts.isPending) onDone();
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  if (selection) {
    return (
      <ForecastAccountsDialog
        itemId={itemId}
        accounts={selection}
        onClose={() => {
          setSelection(null);
          onDone();
        }}
      />
    );
  }
  return null;
}
