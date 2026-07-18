import { useState } from "react";
import {
  Plus,
  MoreHorizontal,
  Home,
  Car,
  Package,
  Boxes,
  Building2,
  Bitcoin,
  Trash2,
  Pencil,
  Scale,
  PiggyBank,
  Landmark,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListAssets,
  useGetAssetsSummary,
  useDeleteAsset,
  useListAccounts,
  useGetSavingsSummary,
  useListAccountGoals,
  useSetAccountGoal,
  getListAssetsQueryKey,
  getGetAssetsSummaryQueryKey,
  getGetDashboardSummaryQueryKey,
  getListAccountGoalsQueryKey,
} from "@workspace/api-client-react";
import type { Asset, Account } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { AssetDialog } from "@/components/assets/asset-dialog";
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

const SAVINGS_INVESTMENT_TYPES = ["savings", "investment", "brokerage"];

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  savings: "Savings",
  investment: "Investment",
  brokerage: "Brokerage",
};

const ASSET_TYPE_LABELS: Record<string, string> = {
  real_estate: "Real Estate",
  vehicle: "Vehicle",
  personal_property: "Personal Property",
  business_interest: "Business Interest",
  cryptocurrency: "Cryptocurrency",
  other: "Other",
};

const getTypeLabel = (type: string) =>
  ASSET_TYPE_LABELS[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const getAssetIcon = (type: string) => {
  switch (type) {
    case "real_estate":
      return <Home className="h-4 w-4" />;
    case "vehicle":
      return <Car className="h-4 w-4" />;
    case "personal_property":
      return <Package className="h-4 w-4" />;
    case "business_interest":
      return <Building2 className="h-4 w-4" />;
    case "cryptocurrency":
      return <Bitcoin className="h-4 w-4" />;
    default:
      return <Boxes className="h-4 w-4" />;
  }
};

const getAssetColor = (type: string) => {
  switch (type) {
    case "real_estate":
      return "text-primary";
    case "vehicle":
      return "text-[#0D2B45]";
    case "personal_property":
      return "text-primary";
    case "business_interest":
      return "text-[#0D2B45]";
    case "cryptocurrency":
      return "text-[#F59E0B]";
    default:
      return "text-primary";
  }
};

function GoalSection({ account, goalAmount }: { account: Account; goalAmount: number | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const setAccountGoal = useSetAccountGoal();
  const [editing, setEditing] = useState(false);
  const [goalInput, setGoalInput] = useState(goalAmount != null ? String(goalAmount) : "");

  function save() {
    const trimmed = goalInput.trim();
    const value = trimmed === "" ? null : parseFloat(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast({ title: "Enter a valid goal amount", variant: "destructive" });
      return;
    }
    setAccountGoal.mutate(
      { accountId: account.id, data: { goalAmount: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAccountGoalsQueryKey() });
          setEditing(false);
          toast({ title: value === null ? "Goal cleared" : "Goal saved" });
        },
        onError: () => toast({ title: "Could not save goal", variant: "destructive" }),
      },
    );
  }

  if (editing || goalAmount == null) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="Set a goal ($)"
          className="h-8 max-w-[240px] text-[13px]"
          value={goalInput}
          onChange={(e) => setGoalInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <Button size="sm" className="h-8" onClick={save} disabled={setAccountGoal.isPending}>
          Save
        </Button>
        {editing && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setEditing(false);
              setGoalInput(goalAmount != null ? String(goalAmount) : "");
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  }

  const pct =
    goalAmount > 0 ? Math.min(100, Math.round((account.currentBalance / goalAmount) * 100)) : 0;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground mb-1.5">
        <button
          type="button"
          className="hover:underline text-left"
          onClick={() => {
            setGoalInput(String(goalAmount));
            setEditing(true);
          }}
        >
          <FormatCurrency amount={account.currentBalance} /> of{" "}
          <FormatCurrency amount={goalAmount} /> goal — {pct}% there
        </button>
        <button
          type="button"
          className="text-[12px] text-[#56A0D3] hover:underline"
          onClick={() => {
            setGoalInput(String(goalAmount));
            setEditing(true);
          }}
        >
          Edit goal
        </button>
      </div>
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "#56A0D3" }}
        />
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  amount,
  caption,
  isLoading,
}: {
  icon: React.ReactNode;
  label: string;
  amount: number;
  caption?: React.ReactNode;
  isLoading: boolean;
}) {
  return (
    <Card className="border-card-border bg-card rounded-xl p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E6F1FB] shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {isLoading ? (
            <Skeleton className="h-7 w-[110px] mt-1" />
          ) : (
            <p className="text-2xl font-bold font-mono">
              <FormatCurrency amount={amount} />
            </p>
          )}
          {caption != null && <p className="text-[12px] text-muted-foreground">{caption}</p>}
        </div>
      </div>
    </Card>
  );
}

export default function AssetsInvestments() {
  const [assetToEdit, setAssetToEdit] = useState<Asset | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<Asset | undefined>(undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: assets, isLoading: isLoadingAssets } = useListAssets();
  const { data: assetsSummary, isLoading: isLoadingSummary } = useGetAssetsSummary();
  const { data: accounts, isLoading: isLoadingAccounts } = useListAccounts();
  const { data: savingsSummary } = useGetSavingsSummary();
  const { data: accountGoals } = useListAccountGoals();
  const deleteAsset = useDeleteAsset();

  const savingsAccounts = (accounts ?? []).filter((a) =>
    SAVINGS_INVESTMENT_TYPES.includes(a.accountType),
  );
  const savingsTotal = savingsAccounts.reduce((s, a) => s + a.currentBalance, 0);
  const manualTotal = assetsSummary?.totalAssets ?? 0;
  const momChange = savingsSummary?.momChange ?? null;
  const goalByAccount = new Map((accountGoals ?? []).map((g) => [g.accountId, g.goalAmount]));

  const handleEdit = (asset: Asset) => {
    setAssetToEdit(asset);
    setIsEditDialogOpen(true);
  };

  const handleDelete = () => {
    if (!assetToDelete) return;
    deleteAsset.mutate(
      { id: assetToDelete.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAssetsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAssetsSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Asset deleted successfully" });
          setAssetToDelete(undefined);
        },
        onError: () => {
          toast({ title: "Failed to delete asset", variant: "destructive" });
          setAssetToDelete(undefined);
        },
      },
    );
  };

  const assetsByType =
    assets?.reduce(
      (acc, asset) => {
        if (!acc[asset.assetType]) acc[asset.assetType] = [];
        acc[asset.assetType].push(asset);
        return acc;
      },
      {} as Record<string, Asset[]>,
    ) || {};

  const isLoadingTotals = isLoadingSummary || isLoadingAccounts;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Assets &amp; Investments</h1>
          <p className="text-muted-foreground mt-1">
            Your complete picture of things you own plus your savings and investments
          </p>
        </div>
        <AssetDialog
          trigger={
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Asset
            </Button>
          }
        />
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          icon={<Scale className="h-5 w-5 text-[#56A0D3]" strokeWidth={1.5} />}
          label="Total Assets & Investments"
          amount={manualTotal + savingsTotal}
          isLoading={isLoadingTotals}
        />
        <SummaryCard
          icon={<Landmark className="h-5 w-5 text-[#56A0D3]" strokeWidth={1.5} />}
          label="Manual Assets"
          amount={manualTotal}
          caption={`${assets?.length ?? 0} asset${(assets?.length ?? 0) === 1 ? "" : "s"}`}
          isLoading={isLoadingTotals}
        />
        <SummaryCard
          icon={<PiggyBank className="h-5 w-5 text-[#56A0D3]" strokeWidth={1.5} />}
          label="Savings & Investments"
          amount={savingsTotal}
          caption={
            <>
              {savingsAccounts.length} account{savingsAccounts.length === 1 ? "" : "s"}
              {momChange != null && (
                <span className={momChange >= 0 ? "text-[#059669] ml-2" : "text-[#dc2626] ml-2"}>
                  {momChange >= 0 ? "▲" : "▼"} <FormatCurrency amount={Math.abs(momChange)} /> vs
                  last month
                </span>
              )}
            </>
          }
          isLoading={isLoadingTotals}
        />
      </div>

      {/* Section 1 — Manual Assets */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">My Assets</h2>
        {isLoadingAssets ? (
          <div className="space-y-4">
            <Skeleton className="h-[200px] w-full" />
          </div>
        ) : assets && assets.length > 0 ? (
          <div className="space-y-6">
            {Object.entries(assetsByType).map(([type, typeAssets]) => (
              <Card key={type} className="bg-card border-border overflow-hidden rounded-xl">
                <CardHeader className="border-b border-border bg-muted/20 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={getAssetColor(type)}>{getAssetIcon(type)}</span>
                      <CardTitle className="text-sm font-medium">{getTypeLabel(type)}</CardTitle>
                    </div>
                    <span className="font-mono font-medium text-sm text-foreground">
                      <FormatCurrency
                        amount={typeAssets.reduce((sum, a) => sum + a.currentBalance, 0)}
                      />
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {typeAssets.map((asset) => (
                      <div
                        key={asset.id}
                        className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors group"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <div
                            className={`h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 ${getAssetColor(asset.assetType)}`}
                          >
                            {getAssetIcon(asset.assetType)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="text-sm font-medium truncate">{asset.assetName}</h4>
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 leading-none shrink-0"
                              >
                                {getTypeLabel(asset.assetType)}
                              </Badge>
                            </div>
                            {asset.purchaseDate && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                Purchased{" "}
                                {new Date(asset.purchaseDate + "T00:00:00").toLocaleDateString(
                                  "en-US",
                                  { month: "short", day: "numeric", year: "numeric" },
                                )}
                              </p>
                            )}
                            {asset.notes && (
                              <p className="text-xs text-muted-foreground/80 mt-1 whitespace-pre-wrap break-words">
                                {asset.notes}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-4 shrink-0">
                          <div className="text-sm font-medium font-mono text-foreground">
                            <FormatCurrency amount={asset.currentBalance} />
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEdit(asset)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setAssetToDelete(asset)}
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
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Scale className="h-8 w-8" />}
            title="No assets added"
            description="Add property, vehicles, and other holdings to get a complete view of your net worth."
            action={<AssetDialog trigger={<Button>Add Asset</Button>} />}
          />
        )}
      </div>

      {/* Section 2 — Savings & Investment Accounts */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Savings &amp; Investment Accounts</h2>
        {isLoadingAccounts ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        ) : savingsAccounts.length === 0 ? (
          <Card className="border-card-border bg-card rounded-xl p-8 text-center text-sm text-muted-foreground">
            No savings or investment accounts yet. Add them in Connected Accounts by selecting
            type Savings, Investment, or Brokerage.
          </Card>
        ) : (
          <div className="space-y-3">
            {savingsAccounts.map((account) => (
              <Card key={account.id} className="border-card-border bg-card rounded-xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold truncate">{account.accountName}</p>
                      <Badge variant="secondary" className="text-[11px]">
                        {ACCOUNT_TYPE_LABELS[account.accountType] ?? account.accountType}
                      </Badge>
                    </div>
                    <p className="text-[12px] text-muted-foreground mt-0.5">
                      {account.institutionName}
                    </p>
                  </div>
                  <p className="text-lg font-bold font-mono shrink-0">
                    <FormatCurrency amount={account.currentBalance} />
                  </p>
                </div>
                <GoalSection
                  account={account}
                  goalAmount={goalByAccount.get(account.id) ?? null}
                />
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Section 3 — Total Net Worth Contribution */}
      <Card className="border-card-border bg-card rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <p className="text-sm font-medium">
            Manual Assets <FormatCurrency amount={manualTotal} /> + Savings &amp; Investment
            Accounts <FormatCurrency amount={savingsTotal} /> ={" "}
            <span className="font-bold font-mono">
              <FormatCurrency amount={manualTotal + savingsTotal} />
            </span>
          </p>
        </div>
        <div className="mt-2 space-y-0.5 text-[12px] text-muted-foreground">
          <p>Retirement accounts are tracked separately in the Retirement section</p>
          <p>Connected checking and credit accounts are tracked in Connected Accounts</p>
        </div>
      </Card>

      <AssetDialog asset={assetToEdit} open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen} />

      <AlertDialog
        open={!!assetToDelete}
        onOpenChange={(open) => !open && setAssetToDelete(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Asset?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove "{assetToDelete?.assetName}" and stop tracking its value.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteAsset.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
