import { useState } from "react";
import { Plus, MoreHorizontal, Home, Car, Package, Boxes, Building2, Trash2, Pencil, Scale } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useListAssets, useGetAssetsSummary, useDeleteAsset, getListAssetsQueryKey, getGetAssetsSummaryQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import type { Asset } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Skeleton } from "@/components/ui/skeleton";
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

const TYPE_LABELS: Record<string, string> = {
  real_estate: "Real Estate",
  vehicle: "Vehicle",
  personal_property: "Personal Property",
  business_interest: "Business Interest",
  other: "Other",
};

const getTypeLabel = (type: string) =>
  TYPE_LABELS[type] ??
  type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const getAssetIcon = (type: string) => {
  switch (type) {
    case 'real_estate': return <Home className="h-4 w-4" />;
    case 'vehicle': return <Car className="h-4 w-4" />;
    case 'personal_property': return <Package className="h-4 w-4" />;
    case 'business_interest': return <Building2 className="h-4 w-4" />;
    default: return <Boxes className="h-4 w-4" />;
  }
};

const getAssetColor = (type: string) => {
  switch (type) {
    case 'real_estate': return 'text-primary';
    case 'vehicle': return 'text-[#0D2B45]';
    case 'personal_property': return 'text-primary';
    case 'business_interest': return 'text-[#0D2B45]';
    default: return 'text-primary';
  }
};

export default function AssetsLiabilities() {
  const [assetToEdit, setAssetToEdit] = useState<Asset | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<Asset | undefined>(undefined);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: assets, isLoading: isLoadingAssets } = useListAssets();
  const { data: summary, isLoading: isLoadingSummary } = useGetAssetsSummary();
  const deleteAsset = useDeleteAsset();

  const handleEdit = (asset: Asset) => {
    setAssetToEdit(asset);
    setIsEditDialogOpen(true);
  };

  const handleDelete = () => {
    if (!assetToDelete) return;

    deleteAsset.mutate({ id: assetToDelete.id }, {
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
      }
    });
  };

  const assetsByType = assets?.reduce((acc, asset) => {
    if (!acc[asset.assetType]) {
      acc[asset.assetType] = [];
    }
    acc[asset.assetType].push(asset);
    return acc;
  }, {} as Record<string, Asset[]>) || {};

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Assets</h1>
          <p className="text-muted-foreground mt-1">Manually tracked items you own — property, vehicles, and other holdings.</p>
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

      {/* Summary Card */}
      <div className="grid grid-cols-1 gap-4">
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Asset Value</CardTitle>
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
      </div>

      {/* Asset Lists */}
      {isLoadingAssets ? (
        <div className="space-y-4">
          <Skeleton className="h-[200px] w-full" />
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
                    <FormatCurrency amount={typeAssets.reduce((sum, a) => sum + a.currentBalance, 0)} />
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {typeAssets.map(asset => (
                    <div key={asset.id} className="flex items-center justify-between p-4 hover:bg-muted/10 transition-colors group">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className={`h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0 ${getAssetColor(asset.assetType)}`}>
                          {getAssetIcon(asset.assetType)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="text-sm font-medium truncate">{asset.assetName}</h4>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 leading-none shrink-0">
                              {getTypeLabel(asset.assetType)}
                            </Badge>
                          </div>
                          {asset.purchaseDate && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Purchased {new Date(asset.purchaseDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
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
                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
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

      <AssetDialog
        asset={assetToEdit}
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
      />

      <AlertDialog open={!!assetToDelete} onOpenChange={(open) => !open && setAssetToDelete(undefined)}>
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
