import { useState } from "react";
import { Plus, MoreHorizontal, Landmark, CreditCard, PiggyBank, Briefcase, TrendingUp, Home, Banknote, Trash2, Pencil, Link2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useListAccounts, useGetAccountsSummary, useDeleteAccount, getListAccountsQueryKey, getGetAccountsSummaryQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import type { Account } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { AccountDialog } from "@/components/accounts/account-dialog";
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
    case 'checking': return 'text-chart-1';
    case 'savings': return 'text-chart-2';
    case 'credit_card': return 'text-chart-3';
    case 'investment': return 'text-chart-4';
    case 'brokerage': return 'text-chart-4';
    case 'retirement': return 'text-chart-2';
    case 'loan': return 'text-destructive';
    case 'mortgage': return 'text-chart-5';
    default: return 'text-primary';
  }
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function Accounts() {
  const [accountToEdit, setAccountToEdit] = useState<Account | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<Account | undefined>(undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: summary, isLoading: isLoadingSummary } = useGetAccountsSummary();
  const deleteAccount = useDeleteAccount();

  const handleEdit = (account: Account) => {
    setAccountToEdit(account);
    setIsEditDialogOpen(true);
  };

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

  const accountsByType = accounts?.reduce((acc, account) => {
    if (!acc[account.accountType]) {
      acc[account.accountType] = [];
    }
    acc[account.accountType].push(account);
    return acc;
  }, {} as Record<string, Account[]>) || {};

  // Signed balance: liabilities (credit cards, loans, mortgages) display as negative
  const signedBalance = (account: Account) =>
    account.isAsset ? account.currentBalance : -account.currentBalance;

  return (
    <TooltipProvider>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Connected Accounts</h1>
            <p className="text-muted-foreground mt-1">Financial accounts that will eventually sync via Plaid.</p>
          </div>
          <AccountDialog
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Account
              </Button>
            }
          />
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Assets</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingSummary ? (
                <Skeleton className="h-8 w-[120px]" />
              ) : (
                <div className="text-2xl font-bold tracking-tight text-foreground">
                  <FormatCurrency amount={summary?.totalAssets || 0} />
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Liabilities</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoadingSummary ? (
                <Skeleton className="h-8 w-[120px]" />
              ) : (
                <div className="text-2xl font-bold tracking-tight text-red-600">
                  {(summary?.totalLiabilities || 0) > 0 ? (
                    <FormatCurrency amount={-(summary?.totalLiabilities || 0)} />
                  ) : (
                    <FormatCurrency amount={0} />
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Account Lists */}
        {isLoadingAccounts ? (
          <div className="space-y-4">
            <Skeleton className="h-[200px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </div>
        ) : accounts && accounts.length > 0 ? (
          <div className="space-y-6">
            {Object.entries(accountsByType).map(([type, typeAccounts]) => {
              const typeTotal = typeAccounts.reduce((sum, a) => sum + signedBalance(a), 0);
              return (
                <Card key={type} className="bg-card border-border overflow-hidden">
                  <CardHeader className="border-b border-border bg-muted/20 py-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={getAccountColor(type)}>{getAccountIcon(type)}</span>
                        <CardTitle className="text-sm font-medium">{getTypeLabel(type)}</CardTitle>
                      </div>
                      <span className={`font-mono font-medium text-sm ${typeTotal < 0 ? 'text-red-600' : 'text-foreground'}`}>
                        <FormatCurrency amount={typeTotal} />
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
                      {typeAccounts.map(account => (
                        <div key={account.id} className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors group">
                          <div className="flex items-start gap-3 min-w-0">
                            <div className="h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-muted-foreground">{account.institutionName.substring(0, 2).toUpperCase()}</span>
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
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {account.accountNumberLast4 ? `····${account.accountNumberLast4} · ` : ""}
                                Updated {formatDate(account.updatedAt)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <div className={`text-sm font-medium font-mono ${account.isAsset ? 'text-foreground' : 'text-red-600'}`}>
                              <FormatCurrency amount={signedBalance(account)} />
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span tabIndex={0}>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled
                                    className="h-7 text-xs text-muted-foreground pointer-events-none"
                                  >
                                    <Link2 className="mr-1.5 h-3 w-3" />
                                    Connect via Plaid
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>Coming soon</TooltipContent>
                            </Tooltip>
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
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Landmark className="h-8 w-8" />}
            title="No accounts added"
            description="Add your checking, savings, and investment accounts to track your net worth."
            action={<AccountDialog trigger={<Button>Add Account</Button>} />}
          />
        )}

        <AccountDialog
          account={accountToEdit}
          open={isEditDialogOpen}
          onOpenChange={setIsEditDialogOpen}
        />

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
