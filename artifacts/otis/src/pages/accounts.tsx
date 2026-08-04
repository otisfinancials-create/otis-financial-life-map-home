import { useEffect, useState } from "react";
import { Plus, MoreHorizontal, Landmark, CreditCard, PiggyBank, Briefcase, TrendingUp, Home, Banknote, Trash2, Pencil, Link2, AlertTriangle, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useListAccounts, useListAccountBalances, useDeleteAccount, useDisconnectPlaidAccount, useUpdateAccount, useUpdateAccountPaymentMode, useDismissPaymentSuggestion, getListAccountsQueryKey, getGetAccountsSummaryQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { AccountDialog } from "@/components/accounts/account-dialog";
import { EnvelopesDialog } from "@/components/accounts/envelopes-dialog";
import { PlaidConnectButton } from "@/components/accounts/plaid-connect-button";
import { PlaidUpdateLink } from "@/components/accounts/plaid-update-link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const TYPE_LABELS: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  investment: "Investment",
  brokerage: "Brokerage",
  credit_card: "Credit Card",
  retirement: "Retirement",
  mortgage: "Mortgage",
  loan: "Loan",
};

const getTypeLabel = (type: string) =>
  TYPE_LABELS[type] ??
  type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const getAccountIcon = (type: string) => {
  switch (type) {
    case 'checking': return <Landmark className="h-4 w-4" />;
    case 'savings': return <PiggyBank className="h-4 w-4" />;
    case 'credit_card': return <CreditCard className="h-4 w-4" />;
    case 'investment': return <Briefcase className="h-4 w-4" />;
    case 'brokerage': return <TrendingUp className="h-4 w-4" />;
    case 'retirement': return <PiggyBank className="h-4 w-4" />;
    case 'mortgage': return <Home className="h-4 w-4" />;
    case 'loan': return <Banknote className="h-4 w-4" />;
    default: return <Landmark className="h-4 w-4" />;
  }
};

const getAccountColor = (type: string) => {
  switch (type) {
    case 'checking': return 'text-primary';
    case 'savings': return 'text-primary';
    case 'credit_card': return 'text-primary';
    case 'investment': return 'text-[#0D2B45]';
    case 'brokerage': return 'text-[#0D2B45]';
    case 'retirement': return 'text-primary';
    case 'loan': return 'text-primary';
    case 'mortgage': return 'text-[#0D2B45]';
    default: return 'text-primary';
  }
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// "3 hours ago" / "yesterday" / "5 days ago" — a cash-flow app must make
// balance freshness legible at a glance.
const relativeTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
};

const STALE_SYNC_MS = 48 * 60 * 60 * 1000;
const isStaleSync = (iso: string) => Date.now() - new Date(iso).getTime() > STALE_SYNC_MS;

export default function Accounts() {
  const [accountToEdit, setAccountToEdit] = useState<Account | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<Account | undefined>(undefined);
  const [envelopesAccount, setEnvelopesAccount] = useState<Account | undefined>(undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: balanceSnapshots } = useListAccountBalances();
  const deleteAccount = useDeleteAccount();
  const updateAccount = useUpdateAccount();
  const disconnectPlaid = useDisconnectPlaidAccount();

  const handleDisconnectPlaid = (account: Account) => {
    disconnectPlaid.mutate({ data: { accountId: account.id } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        toast({ title: "Disconnected from Plaid", description: `${account.accountName} is now a manual account.` });
      },
      onError: () => {
        toast({ title: "Failed to disconnect", variant: "destructive" });
      },
    });
  };

  const handleEdit = (account: Account) => {
    setAccountToEdit(account);
    setIsEditDialogOpen(true);
  };

  // Cards missing cycle config produce NO forecast rows — surface them.
  const unconfiguredCards = (accounts ?? []).filter(
    (a) => a.accountType === "credit_card" && (a.statementDay == null || a.dueDay == null),
  );

  // Fixed-payment suggestion: a last payment materially smaller than the
  // statement balance signals the user is paying down a carried balance at a
  // fixed amount (promo financing etc.). Suggest, never silently switch.
  const fixedPaymentCandidates = (accounts ?? []).filter(
    (a) =>
      a.accountType === "credit_card" &&
      (a.paymentMode ?? "full") === "full" &&
      a.paymentSuggestionDismissedAt == null &&
      (a.lastPaymentAmount ?? 0) > 0 &&
      (a.lastStatementBalance ?? 0) > 0 &&
      (a.lastPaymentAmount ?? 0) < 0.5 * (a.lastStatementBalance ?? 0),
  );
  const dismissSuggestion = useDismissPaymentSuggestion();
  const setPaymentMode = useUpdateAccountPaymentMode();
  const acceptSuggestion = (card: Account) => {
    setPaymentMode.mutate(
      { id: card.id, data: { paymentMode: "fixed", fixedPaymentAmount: card.lastPaymentAmount ?? 0 } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          toast({
            title: "Fixed payment plan set",
            description: result.projectedPayoffDate
              ? `$${(card.lastPaymentAmount ?? 0).toFixed(2)}/month — projected payoff ${result.projectedPayoffDate}. Edit the card to adjust.`
              : `$${(card.lastPaymentAmount ?? 0).toFixed(2)}/month. Edit the card to adjust.`,
          });
        },
        onError: () => toast({ title: "Failed to set payment plan", variant: "destructive" }),
      },
    );
  };
  const declineSuggestion = (card: Account) => {
    dismissSuggestion.mutate(
      { id: card.id },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() }) },
    );
  };

  // Post-link handoff for card-only institutions: once the refreshed account
  // list arrives, open the config dialog for the first card the Liabilities
  // sync could NOT auto-configure. If every new card came back configured,
  // there is nothing to ask.
  const [pendingCardSetupIds, setPendingCardSetupIds] = useState<number[] | null>(null);
  useEffect(() => {
    if (!pendingCardSetupIds || !accounts) return;
    const pendingSet = new Set(pendingCardSetupIds);
    const known = accounts.filter((a) => pendingSet.has(a.id));
    if (known.length === 0) return; // list not refreshed yet
    setPendingCardSetupIds(null);
    const needsSetup = known.find(
      (a) => a.accountType === "credit_card" && (a.statementDay == null || a.dueDay == null),
    );
    if (needsSetup) {
      toast({
        title: "Set up your card",
        description: `Add ${needsSetup.accountName}'s statement and due days so it appears in your forecast.`,
      });
      handleEdit(needsSetup);
    } else {
      toast({
        title: "Card cycle days imported",
        description: "Statement and due days came from your bank — your card is in the forecast.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCardSetupIds, accounts]);

  const handleDelete = () => {
    if (!accountToDelete) return;

    deleteAccount.mutate({ id: accountToDelete.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAccountsSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Account deleted successfully" });
        setAccountToDelete(undefined);
      },
      onError: () => {
        toast({ title: "Failed to delete account", variant: "destructive" });
        setAccountToDelete(undefined);
      }
    });
  };

  // Latest balance snapshot per Plaid account (endpoint returns the most recent
  // snapshot_date per account). Prefer this over the stale accounts.currentBalance.
  const snapshotByPlaidAccountId = new Map(
    (balanceSnapshots ?? [])
      .filter((s) => s.current != null)
      .map((s) => [s.accountId, s.current as number]),
  );

  const displayBalance = (account: Account) =>
    (account.plaidAccountId ? snapshotByPlaidAccountId.get(account.plaidAccountId) : undefined) ??
    account.currentBalance;

  // Signed balance: liabilities (credit cards, loans, mortgages) display as negative
  const signedBalance = (account: Account) =>
    account.isAsset ? displayBalance(account) : -displayBalance(account);

  const assetAccounts = accounts?.filter((a) => a.isAsset) || [];
  const liabilityAccounts = accounts?.filter((a) => !a.isAsset) || [];

  // Update-mode Link session: add an account under an already-connected bank.
  const [updateItem, setUpdateItem] = useState<{ itemId: number; institutionName: string } | null>(null);

  const handleForecastToggle = (account: Account, checked: boolean) => {
    updateAccount.mutate(
      { id: account.id, data: { isForecastAccount: checked } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({
            title: checked ? "Added to your forecast" : "Removed from your forecast",
            description: checked
              ? `We'll track money coming in and going out of ${account.accountName}.`
              : `${account.accountName} is now tracked separately from your bills and spending.`,
          });
        },
        onError: () => toast({ title: "Couldn't update the account", variant: "destructive" }),
      },
    );
  };

  // Totals must match the per-row balances (snapshot-adjusted), so compute them
  // from the same displayBalance source rather than the stale summary fields.
  const totalAssets = assetAccounts.reduce((sum, a) => sum + displayBalance(a), 0);
  const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + displayBalance(a), 0);

  const renderAccountCard = (account: Account) => (
    <Card key={account.id} className="bg-card border-border overflow-hidden rounded-xl">
      <CardContent className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors group">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 overflow-hidden ${getAccountColor(account.accountType)}`}>
            {account.institutionLogo ? (
              <img src={`data:image/png;base64,${account.institutionLogo}`} alt="" className="h-7 w-7 object-contain" />
            ) : (
              getAccountIcon(account.accountType)
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-medium truncate">
                {account.institutionName} — {account.accountName}
              </h4>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 leading-none shrink-0">
                {getTypeLabel(account.accountType)}
              </Badge>
            </div>
            {account.plaidAccountId && account.lastSyncedAt ? (
              isStaleSync(account.lastSyncedAt) ? (
                // A stale balance in a cash-flow app is worse than no balance —
                // past 48h the sync line becomes a warning. amber-800 #92400E
                // (6.36:1 on white) meets WCAG AA.
                <p className="text-xs text-amber-800 font-medium mt-0.5 flex items-center gap-1" data-testid={`text-sync-stale-${account.id}`}>
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {account.accountNumberLast4 ? `····${account.accountNumberLast4} · ` : ""}
                  Last synced {relativeTime(account.lastSyncedAt)} — balance may be out of date
                </p>
              ) : (
                <p className="text-xs text-slate-600 mt-0.5" data-testid={`text-sync-fresh-${account.id}`}>
                  {account.accountNumberLast4 ? `····${account.accountNumberLast4} · ` : ""}
                  Last synced {relativeTime(account.lastSyncedAt)}
                </p>
              )
            ) : (
              <p className="text-xs text-slate-600 mt-0.5">
                {account.accountNumberLast4 ? `····${account.accountNumberLast4} · ` : ""}
                Updated {formatDate(account.updatedAt)}
              </p>
            )}
            {account.notes && (
              <p className="text-xs text-muted-foreground/80 mt-1 whitespace-pre-wrap break-words">
                {account.notes}
              </p>
            )}
            {account.plaidAccountId && account.accountType !== "credit_card" && (
              <label className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer w-fit">
                <Switch
                  checked={account.isForecastAccount}
                  onCheckedChange={(checked) => handleForecastToggle(account, checked)}
                  disabled={updateAccount.isPending}
                  className="scale-75 origin-left"
                  data-testid={`switch-forecast-account-${account.id}`}
                />
                I pay bills from this account
              </label>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className={`text-sm font-medium font-mono ${signedBalance(account) >= 0 ? 'text-[#059669]' : 'text-red-600'}`}>
            <FormatCurrency amount={signedBalance(account)} />
          </div>
          {/* LIVE / MANUAL is more than cosmetics: account removal SOFT-UNLINKS
              (plaid_account_id set to NULL, row kept), so a card can silently
              stop receiving new transactions. This badge is that signal. */}
          {account.plaidAccountId ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0 text-[10px] px-2 py-0.5 shrink-0" data-testid={`badge-live-${account.id}`}>
              <Link2 className="mr-1 h-3 w-3" />
              LIVE
            </Badge>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className="bg-slate-200 text-slate-700 hover:bg-slate-200 border-0 text-[10px] px-2 py-0.5 shrink-0 cursor-default" data-testid={`badge-manual-${account.id}`}>
                  MANUAL{account.wasPlaidLinked ? " · UNLINKED" : ""}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                {account.wasPlaidLinked
                  ? "This account was disconnected from your bank. Its balance no longer updates automatically — edit it to update the balance, or reconnect your bank."
                  : "Manually added — its balance only changes when you edit it."}
              </TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleEdit(account)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              {account.accountType === "credit_card" && (
                <DropdownMenuItem onClick={() => setEnvelopesAccount(account)}>
                  <CreditCard className="mr-2 h-4 w-4" />
                  Manage envelopes
                </DropdownMenuItem>
              )}
              {account.plaidAccountId && account.plaidItemId != null && (
                <DropdownMenuItem
                  onClick={() => setUpdateItem({ itemId: account.plaidItemId!, institutionName: account.institutionName })}
                  data-testid={`menu-add-account-${account.id}`}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add an account at {account.institutionName}
                </DropdownMenuItem>
              )}
              {account.plaidAccountId && (
                <DropdownMenuItem onClick={() => handleDisconnectPlaid(account)}>
                  <Link2 className="mr-2 h-4 w-4" />
                  Disconnect from Plaid
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setAccountToDelete(account)}
                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <TooltipProvider>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Accounts</h1>
            <p className="text-muted-foreground mt-1">Link your bank accounts or add them manually.</p>
          </div>
          <div className="flex items-center gap-2">
            {updateItem && (
              <PlaidUpdateLink
                itemId={updateItem.itemId}
                institutionName={updateItem.institutionName}
                onDone={() => setUpdateItem(null)}
              />
            )}
            <PlaidConnectButton onLinkedCardsNeedSetup={setPendingCardSetupIds} />
            <AccountDialog
              trigger={
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Account
                </Button>
              }
            />
          </div>
        </div>

        {/* Trust banner. ACCURATE TODAY: our Plaid link token requests
            products=[Transactions] with optional Liabilities/Investments/
            Identity (see api-server routes/plaid.ts link-token creation).
            No Auth, no Transfer — we hold no money-movement capability.
            ⚠️ If Auth or Transfer is EVER added to the link token, this badge
            copy must change. Text emerald-900 #064E3B on emerald-50 = 12.6:1. */}
        <Card className="border-emerald-200 bg-emerald-50 rounded-xl" data-testid="banner-read-only">
          <CardContent className="py-3 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-800 shrink-0" />
            <p className="text-sm text-emerald-900 font-medium">
              Read-only connection — we can see your balances and transactions, we cannot move your money.
            </p>
          </CardContent>
        </Card>

        {/* Cards missing statement/due days generate no forecast rows — nudge setup. */}
        {unconfiguredCards.length > 0 && (
          <Card className="border-amber-500/40 bg-amber-500/5 rounded-xl" data-testid="banner-card-setup">
            <CardContent className="py-4 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    {unconfiguredCards.length === 1
                      ? "1 credit card isn't in your forecast yet"
                      : `${unconfiguredCards.length} credit cards aren't in your forecast yet`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Set each card's statement and due days so its payments appear in your forecast.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-8">
                {unconfiguredCards.map((card) => (
                  <Button
                    key={card.id}
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(card)}
                    data-testid={`button-setup-card-${card.id}`}
                  >
                    <CreditCard className="mr-2 h-4 w-4" />
                    Set up {card.accountName}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cards whose last payment was well below the statement balance — the
            user is likely paying down a carried balance at a fixed amount. */}
        {fixedPaymentCandidates.map((card) => (
          <Card key={card.id} className="border-sky-500/40 bg-sky-500/5 rounded-xl" data-testid={`banner-fixed-payment-${card.id}`}>
            <CardContent className="py-4 space-y-3">
              <div className="flex items-start gap-3">
                <CreditCard className="h-5 w-5 text-sky-500 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    You paid <FormatCurrency amount={card.lastPaymentAmount ?? 0} /> on a{" "}
                    <FormatCurrency amount={card.lastStatementBalance ?? 0} /> balance on {card.accountName}.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Are you paying this down at a fixed amount each month? Your forecast currently assumes
                    you'll pay the whole statement at once.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-8">
                <Button
                  size="sm"
                  onClick={() => acceptSuggestion(card)}
                  disabled={setPaymentMode.isPending}
                  data-testid={`button-accept-fixed-${card.id}`}
                >
                  Yes — <FormatCurrency amount={card.lastPaymentAmount ?? 0} />/month
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleEdit(card)}
                  data-testid={`button-edit-fixed-${card.id}`}
                >
                  Yes, a different amount
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => declineSuggestion(card)}
                  disabled={dismissSuggestion.isPending}
                  data-testid={`button-dismiss-fixed-${card.id}`}
                >
                  No, I pay in full
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        {/* Account Lists */}
        {isLoadingAccounts ? (
          <div className="space-y-4">
            <Skeleton className="h-[120px] w-full" />
            <Skeleton className="h-[100px] w-full" />
            <Skeleton className="h-[120px] w-full" />
          </div>
        ) : accounts && accounts.length > 0 ? (
          <div className="space-y-8">
            {/* Assets */}
            <div className="space-y-4">
              <Card className="bg-card border-border rounded-xl">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
                  <CardTitle className="text-base font-semibold">Total Assets</CardTitle>
                  {isLoadingAccounts ? (
                    <Skeleton className="h-8 w-[120px]" />
                  ) : (
                    <div className="text-2xl font-bold tracking-tight text-[#059669]">
                      <FormatCurrency amount={totalAssets} />
                    </div>
                  )}
                </CardHeader>
              </Card>
              {assetAccounts.length > 0 ? (
                assetAccounts.map(renderAccountCard)
              ) : (
                <p className="text-sm text-muted-foreground px-1">No asset accounts yet.</p>
              )}
            </div>

            {/* Liabilities */}
            <div className="space-y-4">
              <Card className="bg-card border-border rounded-xl">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 py-4">
                  <CardTitle className="text-base font-semibold">Total Liabilities</CardTitle>
                  {isLoadingAccounts ? (
                    <Skeleton className="h-8 w-[120px]" />
                  ) : (
                    <div className="text-2xl font-bold tracking-tight text-red-600">
                      {totalLiabilities > 0 ? (
                        <FormatCurrency amount={-totalLiabilities} />
                      ) : (
                        <FormatCurrency amount={0} />
                      )}
                    </div>
                  )}
                </CardHeader>
              </Card>
              {liabilityAccounts.length > 0 ? (
                liabilityAccounts.map(renderAccountCard)
              ) : (
                <p className="text-sm text-muted-foreground px-1">No liability accounts yet.</p>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Landmark className="h-8 w-8" />}
            title="No accounts yet"
            description="Connect your bank to sync balances and transactions automatically."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <PlaidConnectButton onLinkedCardsNeedSetup={setPendingCardSetupIds} />
                <AccountDialog trigger={<Button variant="outline">Add manually</Button>} />
              </div>
            }
          />
        )}

        <AccountDialog
          account={accountToEdit}
          open={isEditDialogOpen}
          onOpenChange={setIsEditDialogOpen}
        />

        {envelopesAccount && (
          <EnvelopesDialog
            account={envelopesAccount}
            open={!!envelopesAccount}
            onOpenChange={(open) => !open && setEnvelopesAccount(undefined)}
          />
        )}

        <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && setAccountToDelete(undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{accountToDelete?.accountName}" and stop tracking its balance. Your historical forecast data may change.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteAccount.isPending ? "Removing..." : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}
