import { useMemo, useState } from "react";
import { Receipt, Plus, MoreHorizontal, Search, Pencil, Trash2, ExternalLink, Moon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListBills,
  useDeleteBill,
  useUpdateBill,
  getListBillsQueryKey,
  getGetUpcomingBillsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Bill } from "@workspace/api-client-react";
import { useSyncForecast } from "@/hooks/use-sync-forecast";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/ui/empty-state";
import { BillDialog } from "@/components/bills/bill-dialog";
import { BillsAnalytics } from "@/components/bills/bills-analytics";
import { categoryMeta, getCategoryEmoji } from "@/utils/categoryIcons";
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

function formatPaymentMethod(raw: string | null | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("credit-card:")) {
    const card = raw.slice("credit-card:".length).trim();
    return card ? `Credit Card – ${card}` : "Credit Card";
  }
  const map: Record<string, string> = {
    "auto-pay": "Auto-pay",
    "manual": "Manual",
    "credit-card": "Credit Card",
  };
  return map[raw] ?? raw;
}

export default function Bills() {
  const [searchTerm, setSearchTerm] = useState("");
  const [billToEdit, setBillToEdit] = useState<Bill | undefined>(undefined);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [billToDelete, setBillToDelete] = useState<Bill | undefined>(undefined);
  const [showInactive, setShowInactive] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading } = useListBills();
  const deleteBill = useDeleteBill();
  const updateBill = useUpdateBill();
  const { sync: syncForecast } = useSyncForecast();

  const searchedBills = useMemo(
    () =>
      bills?.filter((bill) =>
        bill.billName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        bill.category.toLowerCase().includes(searchTerm.toLowerCase())
      ) || [],
    [bills, searchTerm],
  );

  const inactiveCount = useMemo(
    () => searchedBills.filter((b) => !b.isActive).length,
    [searchedBills],
  );

  // Active bills first; inactive bills (when shown) sorted to the bottom.
  const visibleBills = useMemo(() => {
    const list = showInactive ? searchedBills : searchedBills.filter((b) => b.isActive);
    return [...list].sort((a, b) => Number(b.isActive) - Number(a.isActive));
  }, [searchedBills, showInactive]);

  const handleEdit = (bill: Bill) => {
    setBillToEdit(bill);
    setIsEditDialogOpen(true);
  };

  const handleToggleActive = (bill: Bill) => {
    updateBill.mutate(
      { id: bill.id, data: { isActive: !bill.isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          syncForecast();
        },
        onError: () => {
          toast({ title: "Failed to update bill status", variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = () => {
    if (!billToDelete) return;
    deleteBill.mutate({ id: billToDelete.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUpcomingBillsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        toast({ title: "Bill deleted", description: "It and its forecast entries have been removed." });
        setBillToDelete(undefined);
        syncForecast();
      },
      onError: () => {
        toast({ title: "Failed to delete bill", variant: "destructive" });
        setBillToDelete(undefined);
      },
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bills & Subscriptions</h1>
          <p className="text-muted-foreground mt-1">Manage your recurring expenses and forecast commitments.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search bills..."
              className="pl-9 w-full sm:w-[250px] bg-card border-border"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          {inactiveCount > 0 && (
            <Button
              variant="outline"
              onClick={() => setShowInactive((v) => !v)}
            >
              {showInactive ? "Hide Inactive" : `Show Inactive (${inactiveCount})`}
            </Button>
          )}
          <BillDialog
            trigger={
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Bill
              </Button>
            }
          />
        </div>
      </div>

      {!isLoading && <BillsAnalytics bills={bills ?? []} />}

      <Card className="border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-4">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : visibleBills.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Bill Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Due Day</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleBills.map((bill) => (
                  <TableRow
                    key={bill.id}
                    className={`border-border group ${bill.isActive ? "" : "opacity-60"}`}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {bill.companyUrl ? (
                          <a
                            href={bill.companyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={bill.billName}
                            className="hover:text-primary transition-colors flex items-center gap-1 group/link max-w-[200px]"
                          >
                            <span className="truncate">{bill.billName}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover/link:opacity-60 transition-opacity" />
                          </a>
                        ) : (
                          <span className="truncate max-w-[200px]" title={bill.billName}>
                            {bill.billName}
                          </span>
                        )}
                        {bill.isVariable && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground shrink-0">
                            Var
                          </Badge>
                        )}
                        {!bill.isActive && (
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground shrink-0 flex items-center gap-0.5"
                          >
                            <Moon className="h-2.5 w-2.5" />
                            Inactive
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const meta = categoryMeta(bill.category);
                        return (
                          <div className="flex items-center gap-2">
                            <span
                              className="shrink-0"
                              style={{ fontSize: "16px", lineHeight: 1 }}
                              aria-hidden="true"
                            >
                              {getCategoryEmoji(bill.category)}
                            </span>
                            <Badge
                              variant="outline"
                              className="font-normal border-transparent"
                              style={{ backgroundColor: meta.bg, color: meta.text }}
                            >
                              {bill.category}
                            </Badge>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="font-mono">
                      <FormatCurrency amount={bill.amount} />
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground text-sm">
                      {bill.frequency}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      Day {bill.dueDay}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatPaymentMethod(bill.paymentMethod) || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={bill.isActive}
                        onCheckedChange={() => handleToggleActive(bill)}
                        aria-label={`Toggle ${bill.billName} active`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <span className="sr-only">Open menu</span>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => handleEdit(bill)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setBillToDelete(bill)}
                            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={<Receipt className="h-8 w-8" />}
            title={searchTerm ? "No bills found" : "No bills yet"}
            description={
              searchTerm
                ? `No bills matching "${searchTerm}"`
                : "Add your first bill to start forecasting your cash flow."
            }
            className="border-0 bg-transparent rounded-none"
            action={
              !searchTerm && (
                <BillDialog trigger={<Button>Add your first bill</Button>} />
              )
            }
          />
        )}
      </Card>

      <BillDialog
        bill={billToEdit}
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
      />

      <AlertDialog
        open={!!billToDelete}
        onOpenChange={(open) => !open && setBillToDelete(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this bill?</AlertDialogTitle>
            <AlertDialogDescription>
              "{billToDelete?.billName}" and all of its forecasted transactions will be permanently
              deleted. This cannot be undone. To keep the bill but exclude it from your forecast,
              toggle it inactive instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBill.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
