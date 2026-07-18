import { useMemo, useState } from "react";
import { Receipt, Plus, MoreHorizontal, Search, Pencil, Trash2, ExternalLink, Moon, ArrowUp, ArrowDown, ChevronsUpDown, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListBills,
  useDeleteBill,
  useUpdateBill,
  useListForecast,
  getListForecastQueryKey,
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
import { BillDialog, BillForm } from "@/components/bills/bill-dialog";
import { monthlyFactor } from "@/lib/bill-math";
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
    "auto-pay": "Bank Draft",
    "bank-draft": "Bank Draft",
    "manual": "Manual",
    "credit-card": "Credit Card",
  };
  return map[raw] ?? raw;
}

type SortKey = "billName" | "category" | "amount" | "frequency" | "dueDay" | "paymentMethod";
type SortDir = "asc" | "desc";

export default function Bills() {
  const [searchTerm, setSearchTerm] = useState("");
  const [billToEdit, setBillToEdit] = useState<Bill | undefined>(undefined);
  const [view, setView] = useState<"bills" | "planned">("bills");
  const [billToDelete, setBillToDelete] = useState<Bill | undefined>(undefined);
  const [showInactive, setShowInactive] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: bills, isLoading } = useListBills();
  const deleteBill = useDeleteBill();
  const updateBill = useUpdateBill();
  const { sync: syncForecast } = useSyncForecast();

  const searchedBills = useMemo(
    () =>
      bills?.filter((bill) =>
        (bill.billName.toLowerCase().includes(searchTerm.toLowerCase()) ||
          bill.category.toLowerCase().includes(searchTerm.toLowerCase())) &&
        (!selectedCategory || bill.category === selectedCategory)
      ) || [],
    [bills, searchTerm, selectedCategory],
  );

  const inactiveCount = useMemo(
    () => searchedBills.filter((b) => !b.isActive).length,
    [searchedBills],
  );

  // Active bills first; inactive bills (when shown) sorted to the bottom.
  // Within each group, apply the user's column sort if one is active.
  const visibleBills = useMemo(() => {
    const list = showInactive ? searchedBills : searchedBills.filter((b) => b.isActive);
    const compareBy = (a: Bill, b: Bill): number => {
      if (!sortKey) return 0;
      let cmp = 0;
      switch (sortKey) {
        case "amount":
          cmp = a.amount - b.amount;
          break;
        case "dueDay":
          cmp = (a.dueDay ?? 0) - (b.dueDay ?? 0);
          break;
        case "paymentMethod":
          cmp = formatPaymentMethod(a.paymentMethod).localeCompare(formatPaymentMethod(b.paymentMethod));
          break;
        default:
          cmp = String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), undefined, { sensitivity: "base" });
      }
      return sortDir === "asc" ? cmp : -cmp;
    };
    return [...list].sort(
      (a, b) => Number(b.isActive) - Number(a.isActive) || compareBy(a, b),
    );
  }, [searchedBills, showInactive, sortKey, sortDir]);

  const handleEdit = (bill: Bill) => {
    setBillToEdit((current) => (current?.id === bill.id ? undefined : bill));
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
        setBillToEdit((current) => (current?.id === billToDelete.id ? undefined : current));
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
          <h1 className="text-2xl font-bold tracking-tight">Bills</h1>
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

      <div className="flex items-center gap-2">
        {([
          ["bills", "All Bills"],
          ["planned", "Planned vs Actual"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              view === key
                ? "bg-[var(--color-navy)] text-white shadow-sm"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "planned" && <PlannedVsActual bills={bills ?? []} />}

      {view === "bills" && !isLoading && (
        <BillsAnalytics
          bills={bills ?? []}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />
      )}

      {view === "bills" && (
      <div className="flex flex-col lg:flex-row gap-4 items-start">
      <Card className={`border-card-border bg-card rounded-xl overflow-hidden transition-all duration-300 w-full min-w-0 ${billToEdit ? "lg:flex-1 [&_td]:text-[12px] [&_th]:text-[12px] [&_td_.text-sm]:text-[12px]" : "lg:w-full"}`}>
        {isLoading ? (
          <div className="p-8 space-y-4">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : visibleBills.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  {([
                    ["billName", "Bill Name"],
                    ["category", "Category"],
                    ["amount", "Amount"],
                    ["frequency", "Frequency"],
                    ["dueDay", "Due Day"],
                    ["paymentMethod", "Payment"],
                  ] as [SortKey, string][]).map(([key, label]) => (
                    <TableHead key={key}>
                      <button
                        type="button"
                        onClick={() => handleSort(key)}
                        className="flex items-center gap-1 hover:text-foreground transition-colors"
                        aria-label={`Sort by ${label}`}
                      >
                        {label}
                        {sortKey === key ? (
                          sortDir === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleBills.map((bill) => (
                  <TableRow
                    key={bill.id}
                    onClick={() => handleEdit(bill)}
                    className={`border-border group cursor-pointer ${bill.isActive ? "" : "opacity-60"} ${billToEdit?.id === bill.id ? "bg-muted/60" : ""}`}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {bill.companyUrl ? (
                          <a
                            href={bill.companyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
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
                              {getCategoryEmoji(bill.category, bill.billName)}
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
                      {bill.amountType === "positive" ? (
                        <span className="text-[#059669]">
                          +<FormatCurrency amount={bill.amount} />
                        </span>
                      ) : (
                        <FormatCurrency amount={bill.amount} />
                      )}
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
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={bill.isActive}
                        onCheckedChange={() => handleToggleActive(bill)}
                        aria-label={`Toggle ${bill.billName} active`}
                      />
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
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

      {billToEdit && (
        <Card className="border-card-border bg-card rounded-xl w-full lg:w-[300px] lg:min-w-[280px] lg:max-w-[320px] shrink-0 p-4 animate-in slide-in-from-right-4 fade-in duration-300 [&_label]:text-[12px] [&_input]:text-[13px] [&_textarea]:text-[13px] [&_button]:text-[13px] [&_select]:text-[13px]">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">Edit Bill</h2>
              <p className="text-sm text-muted-foreground">{billToEdit.billName}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 -mt-1 -mr-1"
              onClick={() => setBillToEdit(undefined)}
              aria-label="Close edit panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <BillForm
            key={billToEdit.id}
            bill={billToEdit}
            onSaved={() => setBillToEdit(undefined)}
            onCancel={() => setBillToEdit(undefined)}
          />
        </Card>
      )}
      </div>
      )}

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

// ── Planned vs Actual (current month snapshot) ───────────────────────────────
function monthBounds(): { start: string; end: string; label: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(y, m + 1, 0).getDate();
  const label = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay)}`, label };
}

function PlannedVsActual({ bills }: { bills: Bill[] }) {
  const { start, end, label } = monthBounds();
  const { data: txs = [], isLoading } = useListForecast(
    { startDate: start, endDate: end },
    { query: { queryKey: getListForecastQueryKey({ startDate: start, endDate: end }) } },
  );

  const billCategoryById = new Map<number, string>();
  for (const b of bills) billCategoryById.set(b.id, b.category);

  // Planned: monthly-equivalent budget per category from active bills.
  const planned: Record<string, number> = {};
  for (const b of bills) {
    if (!b.isActive) continue;
    planned[b.category] = (planned[b.category] ?? 0) + b.amount * monthlyFactor(b.frequency);
  }

  // Actual: bill-linked forecast rows marked paid this month (not missed).
  const actual: Record<string, number> = {};
  for (const tx of txs) {
    if (!tx.isActual || tx.status === "missed") continue;
    if (tx.sourceBillId == null) continue;
    const category = billCategoryById.get(tx.sourceBillId) ?? tx.category ?? "Other";
    actual[category] = (actual[category] ?? 0) + Math.abs(tx.amount);
  }

  const categories = Array.from(new Set([...Object.keys(planned), ...Object.keys(actual)]))
    .sort((a, b) => (planned[b] ?? 0) - (planned[a] ?? 0));

  const totalPlanned = Object.values(planned).reduce((s, v) => s + v, 0);
  const totalActual = Object.values(actual).reduce((s, v) => s + v, 0);

  return (
    <Card className="border-card-border bg-card rounded-xl overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-semibold">Planned vs Actual — {label}</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          Planned is your monthly-equivalent budget per category; Actual counts bills marked paid this month.
        </p>
      </div>
      {isLoading ? (
        <div className="p-5 space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : categories.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">No active bills yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Planned</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((cat) => {
              const p = planned[cat] ?? 0;
              const a = actual[cat] ?? 0;
              const r = p - a;
              return (
                <TableRow key={cat} className="border-border">
                  <TableCell className="font-medium">
                    <span className="mr-2" style={{ fontSize: 16, lineHeight: 1 }}>{getCategoryEmoji(cat)}</span>
                    {cat}
                  </TableCell>
                  <TableCell className="text-right font-mono"><FormatCurrency amount={p} /></TableCell>
                  <TableCell className="text-right font-mono"><FormatCurrency amount={a} /></TableCell>
                  <TableCell className={`text-right font-mono ${r < 0 ? "text-red-600" : "text-foreground"}`}>
                    <FormatCurrency amount={r} />
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="border-border bg-muted/40 hover:bg-muted/40 font-semibold">
              <TableCell>Total</TableCell>
              <TableCell className="text-right font-mono"><FormatCurrency amount={totalPlanned} /></TableCell>
              <TableCell className="text-right font-mono"><FormatCurrency amount={totalActual} /></TableCell>
              <TableCell className={`text-right font-mono ${totalPlanned - totalActual < 0 ? "text-red-600" : ""}`}>
                <FormatCurrency amount={totalPlanned - totalActual} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
