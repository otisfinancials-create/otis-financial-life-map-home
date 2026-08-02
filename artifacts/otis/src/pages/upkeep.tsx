import { useMemo, useState } from "react";
import { Wrench, Plus, Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBills,
  useDeleteBill,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
  type Bill,
} from "@workspace/api-client-react";
import { UPKEEP_CATEGORIES } from "@workspace/api-zod";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { BillDialog } from "@/components/bills/bill-dialog";
import { useSyncForecast } from "@/hooks/use-sync-forecast";
import { monthlyFactor } from "@/lib/bill-math";

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  "semi-monthly": "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  "semi-annual": "Every 6 months",
  annual: "Annual",
  annually: "Annual",
  custom: "Custom interval",
};

function frequencyLabel(bill: Bill): string {
  if (bill.frequency === "custom" && bill.customIntervalDays != null) {
    return `Every ${bill.customIntervalDays} days`;
  }
  return FREQUENCY_LABELS[bill.frequency] ?? bill.frequency;
}

/**
 * Upkeep — recurring expected expenses (vet visits, HVAC service, car
 * maintenance) modelled as ordinary bills with billKind='upkeep'. They get
 * everything bills get: merchant matching, mark-paid, paying account, card
 * cycle membership, and budget inclusion.
 */
export default function Upkeep() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading } = useListBills();
  const deleteBill = useDeleteBill();
  const { sync: syncForecast } = useSyncForecast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [billToEdit, setBillToEdit] = useState<Bill | undefined>(undefined);

  const upkeepBills = useMemo(
    () => (bills ?? []).filter((b) => b.billKind === "upkeep"),
    [bills],
  );

  const grouped = useMemo(() => {
    const byCategory = new Map<string, Bill[]>();
    for (const bill of upkeepBills) {
      const list = byCategory.get(bill.category) ?? [];
      list.push(bill);
      byCategory.set(bill.category, list);
    }
    // Canonical category order first, then anything else (legacy values).
    const ordered: Array<{ category: string; items: Bill[] }> = [];
    for (const cat of UPKEEP_CATEGORIES) {
      const items = byCategory.get(cat);
      if (items) {
        ordered.push({ category: cat, items });
        byCategory.delete(cat);
      }
    }
    for (const [category, items] of byCategory) ordered.push({ category, items });
    for (const group of ordered) {
      group.items.sort((a, b) => a.billName.localeCompare(b.billName));
    }
    return ordered;
  }, [upkeepBills]);

  const monthlyTotal = useMemo(
    () =>
      upkeepBills
        .filter((b) => b.isActive)
        .reduce((sum, b) => sum + b.amount * monthlyFactor(b.frequency, b.customIntervalDays), 0),
    [upkeepBills],
  );

  const handleDelete = (bill: Bill) => {
    deleteBill.mutate(
      { id: bill.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          toast({ title: "Upkeep item deleted", description: "Forecast is syncing in the background." });
          syncForecast();
        },
        onError: () => toast({ title: "Failed to delete upkeep item", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="page-upkeep">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Wrench className="h-6 w-6 text-muted-foreground" />
            Upkeep
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recurring expected expenses — vet visits, HVAC service, car maintenance. They flow
            into your forecast, budget, and card cycles like any bill.
          </p>
        </div>
        <Button onClick={() => { setBillToEdit(undefined); setDialogOpen(true); }} data-testid="button-add-upkeep">
          <Plus className="h-4 w-4 mr-1" /> Add upkeep item
        </Button>
      </div>

      {upkeepBills.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="text-upkeep-monthly-total">
          Sets aside about{" "}
          <span className="font-medium text-foreground">
            ${monthlyTotal.toFixed(2)}/mo
          </span>{" "}
          across {upkeepBills.filter((b) => b.isActive).length} active item
          {upkeepBills.filter((b) => b.isActive).length === 1 ? "" : "s"}.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : upkeepBills.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <Wrench className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="font-medium">No upkeep items yet</p>
            <p className="text-sm text-muted-foreground">
              Add things like the annual vet visit, HVAC service, or gutter cleaning so their
              cost is planned for instead of a surprise.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ category, items }) => (
            <Card key={category} data-testid={`card-upkeep-${category}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{category}</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {items.map((bill) => (
                  <div key={bill.id} className="flex items-center justify-between gap-3 py-3" data-testid={`row-upkeep-${bill.id}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{bill.billName}</span>
                        {bill.isVariable && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">Est.</Badge>
                        )}
                        {!bill.isActive && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">Inactive</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {frequencyLabel(bill)}
                        {bill.startDate ? ` · from ${bill.startDate}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className="font-medium">${bill.amount.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground">
                          ≈ ${(bill.amount * monthlyFactor(bill.frequency, bill.customIntervalDays)).toFixed(2)}/mo
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => { setBillToEdit(bill); setDialogOpen(true); }} data-testid={`button-edit-upkeep-${bill.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(bill)} data-testid={`button-delete-upkeep-${bill.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <BillDialog
        billKind="upkeep"
        bill={billToEdit}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setBillToEdit(undefined);
        }}
      />
    </div>
  );
}
