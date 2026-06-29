import { useState, useMemo, useRef, useEffect } from "react";
import { format, addMonths } from "date-fns";
import {
  ExternalLink, Plus, Trash2, Check, RefreshCw, Search,
  ChevronDown, ChevronRight, Zap, GripVertical,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListForecast,
  useGetMonthlyForecast,
  useRegenerateForecast,
  useUpdateForecastedTransaction,
  useDeleteForecastedTransaction,
  useCreateForecastedTransaction,
  useGetUserSettings,
  useSaveUserSettings,
  useListBills,
  getListForecastQueryKey,
  getGetMonthlyForecastQueryKey,
  getGetUserSettingsQueryKey,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FormatCurrency } from "@/components/ui/format-currency";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ─── Category styles ─────────────────────────────────────────────────────────

const CAT_STYLES: Record<string, string> = {
  Housing:       "bg-blue-100 text-blue-700",
  Subscriptions: "bg-purple-100 text-purple-700",
  Utilities:     "bg-cyan-100 text-cyan-700",
  Insurance:     "bg-orange-100 text-orange-700",
  Health:        "bg-green-100 text-green-700",
  Food:          "bg-amber-100 text-amber-800",
  Taxes:         "bg-red-100 text-red-700",
  Transportation:"bg-yellow-100 text-yellow-700",
  salary:        "bg-emerald-100 text-emerald-700",
  Other:         "bg-gray-100 text-gray-600",
};
const catStyle = (c: string) => CAT_STYLES[c] ?? "bg-gray-100 text-gray-600";

const MANUAL_CATEGORIES = [
  "Housing","Subscriptions","Utilities","Insurance",
  "Health","Food","Taxes","Transportation","Other",
];

// ─── Types ───────────────────────────────────────────────────────────────────

type TxRow = {
  id: number;
  transactionDate: string;
  description: string;
  amount: number;
  transactionType: string;
  category: string;
  sourceBillId?: number | null;
  sourcePayId?: number | null;
  isActual: boolean;
  isCommitted: boolean;
  createdAt: string;
  runningBalance: number;
  isVariable: boolean;
  companyUrl?: string | null;
};

type MonthGroup = {
  key: string;
  label: string;
  rows: TxRow[];
  income: number;
  expenses: number;
  endBalance: number;
};

// ─── Forecast Page ───────────────────────────────────────────────────────────

export default function Forecast() {
  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");

  // controls
  const [months, setMonths] = useState<1 | 3 | 6 | 12>(6);
  const [view, setView] = useState<"ledger" | "summary">("ledger");
  const [catFilter, setCatFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  // inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // modals
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [balanceInput, setBalanceInput] = useState("");
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualForm, setManualForm] = useState({
    description: "", amount: "",
    transactionDate: todayStr, category: "Other", transactionType: "expense",
  });
  const [selectedTx, setSelectedTx] = useState<TxRow | null>(null);

  // drag-to-move (change date)
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const suppressClickRef = useRef(false);
  const [datePromptTx, setDatePromptTx] = useState<TxRow | null>(null);
  const [datePromptValue, setDatePromptValue] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Date window ──────────────────────────────────────────────────────────
  const startDate = todayStr;
  const endDate   = format(addMonths(today, months), "yyyy-MM-dd");

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: rawTxs = [], isLoading: loadingTxs } = useListForecast(
    { startDate, endDate },
    { query: { queryKey: getListForecastQueryKey({ startDate, endDate }) } },
  );
  const { data: allTxs = [], isLoading: loadingAll } = useListForecast(
    undefined,
    { query: { queryKey: getListForecastQueryKey() } },
  );
  const { data: monthlyData = [], isLoading: loadingMonthly } = useGetMonthlyForecast();
  const { data: userSettings, isLoading: loadingSettings } = useGetUserSettings();
  const { data: bills = [] } = useListBills();

  // ── Mutations ─────────────────────────────────────────────────────────────
  const regenerate = useRegenerateForecast();
  const updateTx   = useUpdateForecastedTransaction();
  const deleteTx   = useDeleteForecastedTransaction();
  const createTx   = useCreateForecastedTransaction();
  const saveSettings = useSaveUserSettings();

  // ── Bills lookup (for companyUrl + isVariable) ────────────────────────────
  const billsMap = useMemo(() => {
    const m: Record<number, { companyUrl?: string | null; isVariable: boolean }> = {};
    for (const b of bills) m[b.id] = { companyUrl: b.companyUrl ?? null, isVariable: b.isVariable };
    return m;
  }, [bills]);

  // ── Auto-generate if empty ────────────────────────────────────────────────
  const autoGenDone = useRef(false);
  useEffect(() => {
    if (autoGenDone.current || loadingAll || (allTxs && allTxs.length > 0)) return;
    autoGenDone.current = true;
    regenerate.mutate(undefined, {
      onSuccess: (r) => {
        invalidate();
        toast({ title: "Forecast generated", description: `${r.created} transactions projected.` });
      },
    });
  }, [loadingAll, allTxs]);

  // ── Starting balance ──────────────────────────────────────────────────────
  const startingBalance: number = userSettings?.startingBalance ?? 0;

  // ── Running balance computation ───────────────────────────────────────────
  const txsWithBalance = useMemo((): TxRow[] => {
    const sorted = [...rawTxs].sort(
      (a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id - b.id,
    );
    let running = startingBalance;
    return sorted.map((t) => {
      const signed = t.transactionType === "income" ? t.amount : -t.amount;
      running += signed;
      const bill = t.sourceBillId ? billsMap[t.sourceBillId] : undefined;
      return {
        ...t,
        runningBalance: running,
        isVariable: bill?.isVariable ?? false,
        companyUrl: bill?.companyUrl ?? null,
      };
    });
  }, [rawTxs, startingBalance, billsMap]);

  // ── Filter ────────────────────────────────────────────────────────────────
  const filtered = useMemo(() =>
    txsWithBalance.filter((t) => {
      if (catFilter !== "all" && t.category !== catFilter) return false;
      if (search && !t.description.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
  [txsWithBalance, catFilter, search]);

  // ── Current-balance marker (last paid/actual row) ─────────────────────────
  const currentBalanceTxId = useMemo(() => {
    let id: number | null = null;
    for (const t of filtered) {
      if (t.isActual) id = t.id;
    }
    return id;
  }, [filtered]);

  // ── Group by month ────────────────────────────────────────────────────────
  const groups = useMemo((): MonthGroup[] => {
    const map: Record<string, MonthGroup> = {};
    for (const t of filtered) {
      const d = new Date(t.transactionDate + "T00:00:00");
      const key = format(d, "yyyy-MM");
      if (!map[key]) {
        map[key] = { key, label: format(d, "MMMM yyyy"), rows: [], income: 0, expenses: 0, endBalance: 0 };
      }
      map[key].rows.push(t);
      if (t.transactionType === "income") map[key].income += t.amount;
      else map[key].expenses += t.amount;
    }
    for (const g of Object.values(map)) {
      g.endBalance = g.rows.at(-1)?.runningBalance ?? 0;
    }
    return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
  }, [filtered]);

  // ── Unique categories for filter ──────────────────────────────────────────
  const categories = useMemo(() => {
    const s = new Set(txsWithBalance.map((t) => t.category));
    return Array.from(s).sort();
  }, [txsWithBalance]);

  // ── Summary rows (monthly + cumulative end balance) ───────────────────────
  const summaryRows = useMemo(() => {
    let bal = startingBalance;
    return monthlyData.slice(0, months).map((m) => {
      bal += m.netCashFlow;
      return { ...m, endBalance: bal };
    });
  }, [monthlyData, months, startingBalance]);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListForecastQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMonthlyForecastQueryKey() });
  };

  const handleRegenerate = () => {
    regenerate.mutate(undefined, {
      onSuccess: (r) => { invalidate(); toast({ title: "Regenerated", description: `${r.created} transactions rebuilt.` }); },
      onError: () => toast({ title: "Failed to regenerate", variant: "destructive" }),
    });
  };

  const handleMarkPaid = (tx: TxRow) => {
    updateTx.mutate({ id: tx.id, data: { isActual: true } }, {
      onSuccess: () => { invalidate(); toast({ title: "Marked as paid" }); setSelectedTx(null); },
      onError: () => toast({ title: "Failed", variant: "destructive" }),
    });
  };

  const handleDelete = (tx: TxRow) => {
    deleteTx.mutate({ id: tx.id }, {
      onSuccess: () => { invalidate(); toast({ title: "Entry deleted" }); setSelectedTx(null); },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  const startEdit = (tx: TxRow, e: React.MouseEvent) => {
    if (tx.isActual) return;
    e.stopPropagation();
    setEditingId(tx.id);
    setEditValue(String(tx.amount));
    setTimeout(() => editRef.current?.select(), 20);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    const val = parseFloat(editValue);
    if (!isNaN(val) && val >= 0) {
      updateTx.mutate({ id: editingId, data: { amount: val } }, {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      });
    }
    setEditingId(null);
  };

  const handleRowDragStart = (tx: TxRow, e: React.DragEvent) => {
    setDraggingId(tx.id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(tx.id)); } catch { /* noop */ }
  };

  const handleRowDrop = (target: TxRow, e: React.DragEvent) => {
    e.preventDefault();
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    const draggedId = draggingId;
    setDraggingId(null);
    if (draggedId === null || draggedId === target.id) return;
    const dragged = txsWithBalance.find((t) => t.id === draggedId);
    if (!dragged) return;
    setDatePromptTx(dragged);
    setDatePromptValue(target.transactionDate);
  };

  const handleSaveDate = () => {
    if (!datePromptTx || !datePromptValue) return;
    updateTx.mutate({ id: datePromptTx.id, data: { transactionDate: datePromptValue } }, {
      onSuccess: () => { invalidate(); setDatePromptTx(null); toast({ title: "Date updated" }); },
      onError: () => toast({ title: "Failed to update date", variant: "destructive" }),
    });
  };

  const handleSaveBalance = () => {
    const val = parseFloat(balanceInput);
    if (isNaN(val)) return;
    saveSettings.mutate({ data: { startingBalance: val, balanceAsOfDate: todayStr } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetUserSettingsQueryKey() });
        setShowBalanceModal(false);
        toast({ title: "Starting balance saved" });
      },
    });
  };

  const handleAddManual = () => {
    const amount = parseFloat(manualForm.amount);
    if (!manualForm.description || isNaN(amount) || amount <= 0) return;
    createTx.mutate({
      data: {
        description: manualForm.description,
        amount,
        transactionDate: manualForm.transactionDate,
        category: manualForm.category,
        transactionType: manualForm.transactionType,
        isCommitted: true,
        isActual: false,
      },
    }, {
      onSuccess: () => {
        invalidate();
        setShowManualModal(false);
        setManualForm({ description: "", amount: "", transactionDate: todayStr, category: "Other", transactionType: "expense" });
        toast({ title: "Entry added" });
      },
      onError: () => toast({ title: "Failed to add entry", variant: "destructive" }),
    });
  };

  const toggleMonth = (label: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="animate-in fade-in duration-500 -mx-6 -mt-6 flex flex-col">

      {/* ── Controls Bar ─────────────────────────────────────────────────────── */}
      <div className="sticky top-[57px] z-20 bg-background/95 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center gap-2 flex-wrap">

        {/* Time range */}
        <div className="flex border border-border rounded-md overflow-hidden bg-card text-xs">
          {([1, 3, 6, 12] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`px-3 py-1.5 font-medium border-r border-border last:border-0 transition-colors ${months === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            >
              {m}mo
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div className="flex border border-border rounded-md overflow-hidden bg-card text-xs">
          {(["ledger", "summary"] as const).map((v, i) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 font-medium transition-colors ${i === 0 ? "border-r border-border" : ""} ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            >
              {v === "ledger" ? "Ledger" : "Monthly Summary"}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="h-8 text-xs w-36 bg-card border-border">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs pl-8 w-44 bg-card border-border"
          />
        </div>

        <div className="flex-1" />

        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setShowManualModal(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Entry
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={handleRegenerate} disabled={regenerate.isPending}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${regenerate.isPending ? "animate-spin" : ""}`} />
          Regenerate
        </Button>
      </div>

      <div className="px-6 py-4 space-y-4">

        {/* ── Starting Balance Banner ─────────────────────────────────────────── */}
        {!loadingSettings && startingBalance === 0 && (
          <div className="flex items-center justify-between bg-primary/5 border border-primary/20 rounded-lg px-4 py-2.5 text-sm">
            <span className="text-muted-foreground text-xs">
              Running balance starts from <span className="text-foreground font-mono font-semibold">$0.00</span>. Add your current balance for accurate projections.
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs ml-4 shrink-0"
              onClick={() => { setBalanceInput(""); setShowBalanceModal(true); }}>
              Set Starting Balance
            </Button>
          </div>
        )}
        {!loadingSettings && startingBalance !== 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Balance seeded from{" "}
              <span className="text-foreground font-mono font-medium"><FormatCurrency amount={startingBalance} /></span>
              {" "}as of {userSettings?.balanceAsOfDate ?? "—"}.
            </span>
            <button className="underline underline-offset-2 hover:text-foreground"
              onClick={() => { setBalanceInput(String(startingBalance)); setShowBalanceModal(true); }}>
              Edit
            </button>
          </div>
        )}

        {/* ── Loading ─────────────────────────────────────────────────────────── */}
        {loadingTxs && (
          <div className="space-y-2 pt-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            LEDGER VIEW
        ══════════════════════════════════════════════════════════════════════ */}
        {!loadingTxs && view === "ledger" && (
          <>
            {groups.length === 0 ? (
              <div className="py-20 text-center text-muted-foreground border border-border rounded-lg">
                <Zap className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No transactions in this range.</p>
                <p className="text-sm mt-1">Try a longer time range or regenerate the forecast.</p>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                {/* Scrollable ledger with its own sticky context */}
                <div className="overflow-y-auto max-h-[calc(100vh-280px)]">

                  {/* Column headers */}
                  <div className="sticky top-0 z-10 grid grid-cols-[110px_1fr_130px_72px_136px_230px] bg-muted/60 border-b border-border text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                    <div className="px-4 py-2.5">Date</div>
                    <div className="px-4 py-2.5">Description</div>
                    <div className="px-4 py-2.5">Category</div>
                    <div className="px-4 py-2.5">Type</div>
                    <div className="px-4 py-2.5 text-right">Amount</div>
                    <div className="px-4 py-2.5 text-right">Balance</div>
                  </div>

                  {/* Month groups */}
                  {groups.map((group) => {
                    const net = group.income - group.expenses;
                    return (
                      <div key={group.key}>
                        {/* Month group header (sticky within scroll container) */}
                        <div className="sticky top-[37px] z-[9] grid grid-cols-[110px_1fr_130px_72px_136px_230px] bg-card/90 backdrop-blur-sm border-b border-t border-border">
                          <div className="col-span-4 px-4 py-2 flex items-center gap-3">
                            <span className="text-[11px] font-bold text-foreground tracking-wide">── {group.label} ──</span>
                            <span className={`text-[11px] font-mono font-medium ${net >= 0 ? "text-emerald-400" : "text-destructive"}`}>
                              Net: {net >= 0 ? "+" : ""}<FormatCurrency amount={net} />
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {group.rows.length} transaction{group.rows.length !== 1 ? "s" : ""}
                            </span>
                          </div>
                          <div className="px-4 py-2 text-right">
                            <span className="text-[11px] font-mono text-muted-foreground">
                              −<FormatCurrency amount={group.expenses} />
                            </span>
                          </div>
                          <div className="px-4 py-2 text-right">
                            <span className={`text-[11px] font-mono font-bold ${group.endBalance < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                              <FormatCurrency amount={group.endBalance} />
                            </span>
                          </div>
                        </div>

                        {/* Transaction rows */}
                        {group.rows.map((tx, idx) => {
                          const isNeg     = tx.runningBalance < 0;
                          const isManual  = !tx.sourceBillId && !tx.sourcePayId;
                          const isEditing = editingId === tx.id;
                          const isToday   = tx.transactionDate === todayStr;
                          const isCurrentBalance = tx.id === currentBalanceTxId;

                          return (
                            <div
                              key={tx.id}
                              draggable={!isEditing}
                              onDragStart={(e) => handleRowDragStart(tx, e)}
                              onDragOver={(e) => { if (draggingId !== null) e.preventDefault(); }}
                              onDrop={(e) => handleRowDrop(tx, e)}
                              onDragEnd={() => setDraggingId(null)}
                              onClick={() => { if (!isEditing && !suppressClickRef.current) setSelectedTx(tx); }}
                              className={[
                                "grid grid-cols-[110px_1fr_130px_72px_136px_230px] border-b border-border/60 last:border-0 group cursor-pointer transition-colors select-none",
                                idx % 2 === 1 ? "bg-muted/20" : "",
                                draggingId === tx.id ? "opacity-40" : "",
                                draggingId !== null && draggingId !== tx.id ? "hover:border-primary hover:border-2" : "",
                                isNeg
                                  ? "bg-red-500/[0.06] hover:bg-red-500/[0.12]"
                                  : "hover:bg-muted/40",
                              ].join(" ")}
                            >
                              {/* Date */}
                              <div className="px-4 py-2.5 flex items-center gap-1.5">
                                <GripVertical
                                  aria-label="Drag to move this transaction to another date"
                                  className="h-3.5 w-3.5 shrink-0 -ml-2 text-muted-foreground/25 group-hover:text-muted-foreground/70 cursor-grab"
                                />
                                <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                  {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d, yyyy")}
                                </span>
                                {isToday && (
                                  <span className="text-[9px] font-bold bg-primary/20 text-primary px-1.5 py-0.5 rounded leading-none">TODAY</span>
                                )}
                              </div>

                              {/* Description */}
                              <div className="px-4 py-2.5 flex items-center gap-1.5 min-w-0">
                                <span className="font-medium text-sm truncate min-w-0">{tx.description}</span>
                                {tx.companyUrl && (
                                  <a
                                    href={tx.companyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
                                    title="Open website"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                                {tx.isActual && (
                                  <Badge className="shrink-0 text-[9px] px-1.5 h-4 bg-primary/20 text-primary border-0 rounded-full leading-none">Paid</Badge>
                                )}
                                {isManual && (
                                  <Badge className="shrink-0 text-[9px] px-1.5 h-4 bg-muted text-muted-foreground border-0 rounded-full leading-none">Manual</Badge>
                                )}
                              </div>

                              {/* Category */}
                              <div className="px-4 py-2.5 flex items-center">
                                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${catStyle(tx.category)}`}>
                                  {tx.category}
                                </span>
                              </div>

                              {/* Type */}
                              <div className="px-4 py-2.5 flex items-center">
                                <span className={`text-[11px] font-medium ${tx.transactionType === "income" ? "text-emerald-400" : "text-zinc-400"}`}>
                                  {tx.transactionType === "income" ? "Income" : "Bill"}
                                </span>
                              </div>

                              {/* Amount (double-click to edit) */}
                              <div
                                className="px-4 py-2.5 flex items-center justify-end"
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => startEdit(tx, e)}
                              >
                                {isEditing ? (
                                  <input
                                    ref={editRef}
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={commitEdit}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") commitEdit();
                                      if (e.key === "Escape") setEditingId(null);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-24 text-right text-sm font-mono bg-background border border-primary rounded px-2 py-0.5 outline-none focus:ring-1 focus:ring-primary"
                                    autoFocus
                                  />
                                ) : (
                                  <span
                                    className={`font-mono text-sm ${tx.transactionType === "income" ? "text-emerald-400" : "text-foreground"}`}
                                    title={tx.isActual ? "Locked — already paid" : "Double-click to edit"}
                                  >
                                    {tx.isVariable && <span className="text-muted-foreground mr-0.5">~</span>}
                                    {tx.transactionType === "income" ? "+" : "−"}
                                    <FormatCurrency amount={tx.amount} />
                                  </span>
                                )}
                              </div>

                              {/* Running Balance + row actions */}
                              <div className="px-4 py-2.5 flex items-center justify-end gap-2">
                                <span className={`font-mono text-sm font-bold ${isNeg ? "text-destructive" : "text-foreground"}`}>
                                  {isNeg && "−"}
                                  <FormatCurrency amount={Math.abs(tx.runningBalance)} />
                                </span>
                                {isCurrentBalance && (
                                  <Badge className="shrink-0 text-[9px] px-1.5 h-4 bg-primary/20 text-primary border-0 rounded-full leading-none whitespace-nowrap">
                                    Current Balance
                                  </Badge>
                                )}
                                {/* Action buttons (reveal on hover) */}
                                <div
                                  className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {!tx.isActual && tx.transactionType === "expense" && (
                                    <button
                                      title="Mark as paid"
                                      onClick={() => handleMarkPaid(tx)}
                                      className="text-muted-foreground/60 hover:text-emerald-400 transition-colors"
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {isManual && (
                                    <button
                                      title="Delete manual entry"
                                      onClick={() => handleDelete(tx)}
                                      className="text-muted-foreground/60 hover:text-destructive transition-colors"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            MONTHLY SUMMARY VIEW
        ══════════════════════════════════════════════════════════════════════ */}
        {!loadingTxs && view === "summary" && (
          <div className="space-y-4">
            {/* Chart */}
            {!loadingMonthly && monthlyData.length > 0 && (
              <Card className="bg-card border-border">
                <CardHeader className="pb-2 pt-4 px-6">
                  <CardTitle className="text-sm font-semibold">
                    Income vs Expenses — {months}-Month View
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-6 pb-4">
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={monthlyData.slice(0, months)}
                        margin={{ top: 8, right: 0, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" axisLine={false} tickLine={false}
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} dy={8} />
                        <YAxis axisLine={false} tickLine={false}
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          tickFormatter={(v) => `$${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} />
                        <Tooltip
                          cursor={{ fill: "hsl(var(--muted)/0.3)" }}
                          contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
                          itemStyle={{ color: "hsl(var(--foreground))" }}
                          formatter={(v: number, name: string) => [
                            new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v),
                            name === "totalIncome" ? "Income" : "Expenses",
                          ]}
                        />
                        <Bar dataKey="totalIncome" name="totalIncome" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} maxBarSize={36} />
                        <Bar dataKey="totalExpenses" name="totalExpenses" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} maxBarSize={36} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Summary accordion table */}
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="grid grid-cols-[1fr_130px_130px_130px_148px] bg-muted/60 border-b border-border text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                <div className="px-4 py-2.5">Month</div>
                <div className="px-4 py-2.5 text-right">Income</div>
                <div className="px-4 py-2.5 text-right">Expenses</div>
                <div className="px-4 py-2.5 text-right">Net Flow</div>
                <div className="px-4 py-2.5 text-right">End Balance</div>
              </div>

              {summaryRows.map((m) => {
                const expanded = expandedMonths.has(m.label);
                const monthGroup = groups.find((g) => g.label === m.label);
                const net = m.netCashFlow;
                return (
                  <div key={m.label} className="border-b border-border last:border-0">
                    {/* Summary row */}
                    <div
                      className="grid grid-cols-[1fr_130px_130px_130px_148px] cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => toggleMonth(m.label)}
                    >
                      <div className="px-4 py-3 flex items-center gap-2">
                        {expanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        }
                        <span className="font-medium text-sm">{m.label}</span>
                        {monthGroup && (
                          <span className="text-[10px] text-muted-foreground">
                            {monthGroup.rows.length} items
                          </span>
                        )}
                      </div>
                      <div className="px-4 py-3 text-right font-mono text-sm text-emerald-400">
                        {m.totalIncome > 0 ? <FormatCurrency amount={m.totalIncome} /> : <span className="text-muted-foreground/30">—</span>}
                      </div>
                      <div className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                        {m.totalExpenses > 0 ? <FormatCurrency amount={m.totalExpenses} /> : <span className="text-muted-foreground/30">—</span>}
                      </div>
                      <div className={`px-4 py-3 text-right font-mono text-sm font-semibold ${net >= 0 ? "text-emerald-400" : "text-destructive"}`}>
                        {net >= 0 ? "+" : ""}<FormatCurrency amount={net} />
                      </div>
                      <div className={`px-4 py-3 text-right font-mono text-sm font-bold ${m.endBalance < 0 ? "text-destructive" : "text-foreground"}`}>
                        <FormatCurrency amount={m.endBalance} />
                      </div>
                    </div>

                    {/* Expanded sub-rows */}
                    {expanded && monthGroup && (
                      <div className="border-t border-border/40 bg-background/40">
                        {monthGroup.rows.map((tx) => (
                          <div
                            key={tx.id}
                            className="grid grid-cols-[1fr_130px_130px_130px_148px] border-b border-border/30 last:border-0 hover:bg-muted/20 cursor-pointer"
                            onClick={() => setSelectedTx(tx)}
                          >
                            <div className="px-4 py-2 pl-10 flex items-center gap-3 min-w-0">
                              <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                                {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d")}
                              </span>
                              <span className="text-xs text-foreground truncate">{tx.description}</span>
                              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${catStyle(tx.category)}`}>
                                {tx.category}
                              </span>
                            </div>
                            <div className={`px-4 py-2 text-right font-mono text-xs ${tx.transactionType === "income" ? "text-emerald-400" : "text-transparent select-none"}`}>
                              <FormatCurrency amount={tx.amount} />
                            </div>
                            <div className={`px-4 py-2 text-right font-mono text-xs ${tx.transactionType !== "income" ? "text-muted-foreground" : "text-transparent select-none"}`}>
                              <FormatCurrency amount={tx.amount} />
                            </div>
                            <div className={`px-4 py-2 text-right font-mono text-xs ${tx.transactionType === "income" ? "text-emerald-400" : "text-muted-foreground"}`}>
                              {tx.transactionType === "income" ? "+" : "−"}<FormatCurrency amount={tx.amount} />
                            </div>
                            <div className={`px-4 py-2 text-right font-mono text-xs font-semibold ${tx.runningBalance < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                              <FormatCurrency amount={tx.runningBalance} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          STARTING BALANCE MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={showBalanceModal} onOpenChange={setShowBalanceModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set Starting Balance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              Enter your current checking account balance. This seeds the running balance column so projections are accurate.
            </p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
              <Input
                value={balanceInput}
                onChange={(e) => setBalanceInput(e.target.value)}
                className="pl-7 font-mono"
                placeholder="0.00"
                type="number"
                step="0.01"
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveBalance(); }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBalanceModal(false)}>Cancel</Button>
            <Button onClick={handleSaveBalance} disabled={saveSettings.isPending}>
              {saveSettings.isPending ? "Saving…" : "Save Balance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════════════════════════════════
          ADD MANUAL ENTRY MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={showManualModal} onOpenChange={setShowManualModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Manual Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input
                value={manualForm.description}
                onChange={(e) => setManualForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g., Vacation trip deposit"
                className="mt-1"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Amount</label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                  <Input
                    value={manualForm.amount}
                    onChange={(e) => setManualForm((f) => ({ ...f, amount: e.target.value }))}
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    min="0"
                    className="pl-7 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Date</label>
                <Input
                  type="date"
                  value={manualForm.transactionDate}
                  onChange={(e) => setManualForm((f) => ({ ...f, transactionDate: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Category</label>
                <Select value={manualForm.category} onValueChange={(v) => setManualForm((f) => ({ ...f, category: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salary">Salary</SelectItem>
                    {MANUAL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Type</label>
                <Select value={manualForm.transactionType} onValueChange={(v) => setManualForm((f) => ({ ...f, transactionType: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expense">Expense</SelectItem>
                    <SelectItem value="income">Income (Bonus, etc.)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowManualModal(false)}>Cancel</Button>
            <Button onClick={handleAddManual} disabled={createTx.isPending}>
              {createTx.isPending ? "Adding…" : "Add Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════════════════════════════════
          MOVE TRANSACTION (CHANGE DATE) MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={!!datePromptTx} onOpenChange={(open) => { if (!open) setDatePromptTx(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move Transaction</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              Set a new date for{" "}
              <span className="text-foreground font-medium">{datePromptTx?.description}</span>.
            </p>
            <div>
              <label className="text-xs font-medium text-muted-foreground">New date</label>
              <Input
                type="date"
                value={datePromptValue}
                onChange={(e) => setDatePromptValue(e.target.value)}
                className="mt-1"
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveDate(); }}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDatePromptTx(null)}>Cancel</Button>
            <Button onClick={handleSaveDate} disabled={updateTx.isPending}>
              {updateTx.isPending ? "Saving…" : "Save Date"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════════════════════════════════
          TRANSACTION DETAIL SHEET
      ══════════════════════════════════════════════════════════════════════ */}
      <Sheet open={!!selectedTx} onOpenChange={(open) => { if (!open) setSelectedTx(null); }}>
        <SheetContent className="w-80 sm:w-[380px] flex flex-col gap-0">
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle className="text-base">{selectedTx?.description}</SheetTitle>
          </SheetHeader>
          {selectedTx && (
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Date</div>
                  <div className="font-mono">{format(new Date(selectedTx.transactionDate + "T00:00:00"), "MMMM d, yyyy")}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Amount</div>
                  <div className={`font-mono font-semibold text-base ${selectedTx.transactionType === "income" ? "text-emerald-400" : "text-foreground"}`}>
                    {selectedTx.transactionType === "income" ? "+" : "−"}<FormatCurrency amount={selectedTx.amount} />
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Category</div>
                  <span className={`text-xs px-2.5 py-1 rounded-full ${catStyle(selectedTx.category)}`}>
                    {selectedTx.category}
                  </span>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Type</div>
                  <div className="text-sm">{selectedTx.transactionType === "income" ? "Income" : "Bill"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Running Balance</div>
                  <div className={`font-mono font-bold text-base ${selectedTx.runningBalance < 0 ? "text-destructive" : "text-foreground"}`}>
                    {selectedTx.runningBalance < 0 && "−"}
                    <FormatCurrency amount={Math.abs(selectedTx.runningBalance)} />
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Status</div>
                  <div className="text-sm">
                    {selectedTx.isActual
                      ? <span className="text-primary">Paid</span>
                      : selectedTx.isCommitted
                      ? <span className="text-amber-400">Committed</span>
                      : <span className="text-muted-foreground">Projected</span>
                    }
                  </div>
                </div>
              </div>

              {selectedTx.companyUrl && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Website</div>
                  <a
                    href={selectedTx.companyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {selectedTx.companyUrl}
                  </a>
                </div>
              )}

              <div className="space-y-2 pt-2">
                {!selectedTx.isActual && selectedTx.transactionType === "expense" && (
                  <Button className="w-full" variant="outline" onClick={() => handleMarkPaid(selectedTx)}>
                    <Check className="h-4 w-4 mr-2 text-emerald-400" />
                    Mark as Paid
                  </Button>
                )}
                {!selectedTx.sourceBillId && !selectedTx.sourcePayId && (
                  <Button className="w-full" variant="destructive" onClick={() => handleDelete(selectedTx)}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Entry
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
