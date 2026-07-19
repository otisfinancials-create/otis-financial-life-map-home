import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Link2, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useCreatePlaidLinkToken,
  useExchangePlaidToken,
  getListAccountsQueryKey,
  getGetAccountsSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

export function PlaidConnectButton() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createLinkToken = useCreatePlaidLinkToken();
  const exchangeToken = useExchangePlaidToken();

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
    createLinkToken.mutate(undefined, {
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
    <Button variant="outline" onClick={handleClick} disabled={busy}>
      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
      {exchangeToken.isPending ? "Importing accounts..." : busy ? "Connecting..." : "Connect Bank Account"}
    </Button>
  );
}
