import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { format, addMonths, subDays } from "date-fns";
import {
  ExternalLink, Plus, Trash2, Check, RefreshCw, RefreshCcw, Search,
  ChevronRight, Zap, GripVertical, Scale, Download,
  X, RotateCcw, FileSpreadsheet, FileText, ClipboardCopy,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListForecast,
  useGetMonthlyForecast,
  useRegenerateForecast,
  useUpdateForecastedTransaction,
  useDeleteForecastedTransaction,
  useCreateForecastedTransaction,
  useReorderForecast,
  useGetUserSettings,
  useListBills,
  useSyncBalance,
  useListBalanceSyncs,
  getListForecastQueryKey,
  getGetMonthlyForecastQueryKey,
  getGetUserSettingsQueryKey,
  getListBalanceSyncsQueryKey,
  type BalanceSync,
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Adjustment:    "bg-sky-100 text-sky-700",
  "Balance Update": "bg-sky-100 text-sky-700",
  pets:              "bg-teal-100 text-teal-700",
  vacations:         "bg-teal-100 text-teal-700",
  home_improvements: "bg-teal-100 text-teal-700",
  education:         "bg-teal-100 text-teal-700",
  celebrations:      "bg-teal-100 text-teal-700",
  vehicle:           "bg-teal-100 text-teal-700",
  medical:           "bg-teal-100 text-teal-700",
};
const catStyle = (c: string) => CAT_STYLES[c] ?? "bg-gray-100 text-gray-600";

const MANUAL_CATEGORIES = [
  "Housing","Subscriptions","Utilities","Insurance",
  "Health","Food","Taxes","Transportation","Other",
];

// ─── Validation ──────────────────────────────────────────────────────────────

const DESC_MAX = 100;
// Numeric only: up to 9 digits before the decimal, up to 2 decimal places.
const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;

function validateAmount(v: string): string | null {
  if (!v.trim()) return "Amount is required";
  if (!AMOUNT_RE.test(v.trim())) return "Enter a valid amount (up to 9 digits, max 2 decimal places)";
  return null;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span className={`text-[10px] font-mono ${value.length > max ? "text-destructive" : "text-muted-foreground"}`}>
      {value.length}/{max}
    </span>
  );
}

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
  sourceLifeEventId?: number | null;
  sourceBalanceSyncId?: number | null;
  isActual: boolean;
  isCommitted: boolean;
  status?: string | null;
  notes?: string | null;
  forecastedAmount?: number | null;
  sortOrder: number;
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
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualForm, setManualForm] = useState({
    description: "", amount: "",
    transactionDate: todayStr, category: "Other", transactionType: "expense",
  });
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({});
  const [selectedTx, setSelectedTx] = useState<TxRow | null>(null);
  const [editForm, setEditForm] = useState({
    transactionDate: "", description: "", category: "Other",
    transactionType: "expense", amount: "", notes: "", isActual: false,
  });
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [futurePaidDate, setFuturePaidDate] = useState<string | null>(null);
  const [recurringPrompt, setRecurringPrompt] = useState<{ id: number; data: Record<string, unknown> } | null>(null);

  // balance update ("Update Current Balance")
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncForm, setSyncForm] = useState({ actualBalance: "", syncDate: todayStr });
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [syncResult, setSyncResult] = useState<BalanceSync | null>(null);

  // drag-to-move (change date) + drag-to-reorder (within a date)
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ id: number; pos: "before" | "after" } | null>(null);
  const suppressClickRef = useRef(false);
  const [datePromptTx, setDatePromptTx] = useState<TxRow | null>(null);
  const [datePromptValue, setDatePromptValue] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Date window ──────────────────────────────────────────────────────────
  // Rolling lookback: include the 30 days before today so recently-due
  // transactions (paid / missed / overdue) show alongside the future forecast.
  // Anything older is archived — still stored in history, no longer shown.
  const startDate = format(subDays(today, 30), "yyyy-MM-dd");
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
  const { data: balanceSyncs = [] } = useListBalanceSyncs();
  const lastSync = balanceSyncs[0] ?? null;

  // ── Mutations ─────────────────────────────────────────────────────────────
  const regenerate = useRegenerateForecast();
  const updateTx   = useUpdateForecastedTransaction();
  const deleteTx   = useDeleteForecastedTransaction();
  const createTx   = useCreateForecastedTransaction();
  const reorderTx  = useReorderForecast();
  const syncBalance = useSyncBalance();

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
  // Balance Update rows (sourceBalanceSyncId set) are OVERRIDES: the balance
  // shown at that row IS the entered value, and all later rows calculate
  // forward from it. Missed rows never affect the balance.
  //   - With overrides: anchor on the latest override dated ≤ today; roll
  //     forward from it (later overrides re-anchor) and back-fill earlier rows
  //     (earlier overrides re-anchor going backward too).
  //   - Without overrides: anchor so the balance at the start of today equals
  //     the user's starting balance, back-filling the lookback rows.
  const txsWithBalance = useMemo((): TxRow[] => {
    const sorted = [...rawTxs].sort(
      (a, b) =>
        a.transactionDate.localeCompare(b.transactionDate) ||
        a.sortOrder - b.sortOrder ||
        a.id - b.id,
    );
    const isOverride = (t: typeof sorted[number]) => t.sourceBalanceSyncId != null;
    const signed = (t: typeof sorted[number]) =>
      t.status === "missed" ? 0 : t.transactionType === "income" ? t.amount : -t.amount;

    const balances = new Array<number>(sorted.length).fill(0);
    let anchorIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (isOverride(sorted[i]) && sorted[i].transactionDate <= todayStr) anchorIdx = i;
    }

    if (anchorIdx >= 0) {
      // Forward from the anchor override.
      let run = sorted[anchorIdx].amount;
      balances[anchorIdx] = run;
      for (let i = anchorIdx + 1; i < sorted.length; i++) {
        run = isOverride(sorted[i]) ? sorted[i].amount : run + signed(sorted[i]);
        balances[i] = run;
      }
      // Back-fill earlier rows; earlier overrides re-anchor the value.
      let back = sorted[anchorIdx].amount;
      for (let i = anchorIdx - 1; i >= 0; i--) {
        const next = sorted[i + 1];
        back -= isOverride(next) ? 0 : signed(next);
        if (isOverride(sorted[i])) back = sorted[i].amount;
        balances[i] = back;
      }
    } else {
      const pastNet = sorted
        .filter((t) => t.transactionDate < todayStr)
        .reduce((sum, t) => sum + signed(t), 0);
      let run = startingBalance - pastNet;
      for (let i = 0; i < sorted.length; i++) {
        // A future-dated override still re-anchors the running balance.
        run = isOverride(sorted[i]) ? sorted[i].amount : run + signed(sorted[i]);
        balances[i] = run;
      }
    }

    return sorted.map((t, i) => {
      const bill = t.sourceBillId ? billsMap[t.sourceBillId] : undefined;
      return {
        ...t,
        runningBalance: balances[i],
        isVariable: bill?.isVariable ?? false,
        companyUrl: bill?.companyUrl ?? null,
      };
    });
  }, [rawTxs, startingBalance, billsMap, todayStr]);

  // ── Filter ────────────────────────────────────────────────────────────────
  const filtered = useMemo(() =>
    txsWithBalance.filter((t) => {
      if (catFilter !== "all" && t.category !== catFilter) return false;
      if (search && !t.description.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
  [txsWithBalance, catFilter, search]);

  // Row currently being dragged (for date-aware drop affordances)
  const draggedRow = useMemo(
    () => (draggingId === null ? null : txsWithBalance.find((t) => t.id === draggingId) ?? null),
    [draggingId, txsWithBalance],
  );

  // ── Current-balance marker ────────────────────────────────────────────────
  // Only rows dated today or earlier qualify — marking a future row as paid
  // must never move the Current Balance label (TC-F12). The most recent
  // balance-update override wins over paid rows if it is later.
  const currentBalanceTxId = useMemo(() => {
    let id: number | null = null;
    for (const t of filtered) {
      if (t.transactionDate > todayStr) break;
      if (t.isActual || t.sourceBalanceSyncId != null) id = t.id;
    }
    return id;
  }, [filtered, todayStr]);

  // ── Past / future boundary (for the TODAY divider) ────────────────────────
  const hasPastRows = useMemo(
    () => filtered.some((t) => t.transactionDate < todayStr),
    [filtered, todayStr],
  );
  const firstFutureTxId = useMemo(
    () => filtered.find((t) => t.transactionDate >= todayStr)?.id ?? null,
    [filtered, todayStr],
  );

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
      // Balance updates are balance values (not cash flows) and missed rows
      // never happened — neither counts toward monthly income/expense totals.
      if (t.sourceBalanceSyncId == null && t.status !== "missed") {
        if (t.transactionType === "income") map[key].income += t.amount;
        else map[key].expenses += t.amount;
      }
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

  // ── Summary rows ──────────────────────────────────────────────────────────
  // Derived directly from the ledger month groups so Income / Expenses / Net /
  // End Balance always match exactly what the Ledger view shows (TC-F18).
  const summaryRows = groups;

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
    // TC-F12: future rows cannot be marked as paid — explain instead.
    if (tx.transactionDate > todayStr) {
      setFuturePaidDate(tx.transactionDate);
      return;
    }
    updateTx.mutate({ id: tx.id, data: { isActual: true, status: null } }, {
      onSuccess: () => {
        invalidate();
        toast({ title: tx.transactionType === "income" ? "Confirmed received" : "Marked as paid" });
        setSelectedTx(null);
      },
      onError: () => toast({ title: "Failed", variant: "destructive" }),
    });
  };

  const handleMarkMissed = (tx: TxRow) => {
    updateTx.mutate({ id: tx.id, data: { status: "missed", isActual: false } }, {
      onSuccess: () => { invalidate(); toast({ title: "Marked as missed", description: "This row no longer affects the running balance." }); setSelectedTx(null); },
      onError: () => toast({ title: "Failed", variant: "destructive" }),
    });
  };

  const handleUnmarkMissed = (tx: TxRow) => {
    updateTx.mutate({ id: tx.id, data: { status: null } }, {
      onSuccess: () => { invalidate(); toast({ title: "Restored", description: "The row counts toward the running balance again." }); },
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
    if (tx.isActual || tx.sourceBalanceSyncId != null) return;
    e.stopPropagation();
    setEditingId(tx.id);
    setEditValue(String(tx.amount));
    setTimeout(() => editRef.current?.select(), 20);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    const err = validateAmount(editValue);
    if (!err) {
      const prev = txsWithBalance.find((t) => t.id === editingId);
      const val = parseFloat(editValue);
      const data: { amount: number; forecastedAmount?: number } = { amount: val };
      // First time the amount deviates from plan, remember the planned value
      // so the variance indicator can show "vs planned".
      if (prev && prev.forecastedAmount == null && val !== prev.amount) data.forecastedAmount = prev.amount;
      updateTx.mutate({ id: editingId, data }, {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      });
    } else if (editValue.trim() !== "") {
      toast({ title: "Invalid amount", description: err, variant: "destructive" });
    }
    setEditingId(null);
  };

  const handleRowDragStart = (tx: TxRow, e: React.DragEvent) => {
    setDraggingId(tx.id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(tx.id)); } catch { /* noop */ }
  };

  const handleRowDragOver = (target: TxRow, e: React.DragEvent) => {
    if (draggingId === null) return;
    e.preventDefault();
    // Only show an in-between insertion line when reordering within the same date.
    if (!draggedRow || draggedRow.id === target.id || draggedRow.transactionDate !== target.transactionDate) {
      if (dragOver !== null) setDragOver(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const pos: "before" | "after" = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (dragOver?.id !== target.id || dragOver?.pos !== pos) setDragOver({ id: target.id, pos });
  };

  const handleRowDrop = (target: TxRow, e: React.DragEvent) => {
    e.preventDefault();
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    const draggedId = draggingId;
    const currentDragOver = dragOver;
    setDraggingId(null);
    setDragOver(null);
    if (draggedId === null || draggedId === target.id) return;
    const dragged = txsWithBalance.find((t) => t.id === draggedId);
    if (!dragged) return;

    // Same date → reorder the dragged row to its new position within that day.
    if (dragged.transactionDate === target.transactionDate) {
      // Balance Update rows are pinned first (sortOrder -1) — never move them
      // or allow drops relative to them.
      if (dragged.sourceBalanceSyncId != null || target.sourceBalanceSyncId != null) return;
      const remaining = txsWithBalance
        .filter((t) =>
          t.transactionDate === target.transactionDate &&
          t.id !== draggedId &&
          t.sourceBalanceSyncId == null,
        );
      const targetIdx = remaining.findIndex((t) => t.id === target.id);
      if (targetIdx === -1) return;
      const pos = currentDragOver?.id === target.id ? currentDragOver.pos : "before";
      remaining.splice(pos === "after" ? targetIdx + 1 : targetIdx, 0, dragged);
      const ids = remaining.map((t) => t.id);
      reorderTx.mutate({ data: { ids } }, {
        onSuccess: () => invalidate(),
        onError: () => toast({ title: "Failed to reorder", variant: "destructive" }),
      });
      return;
    }

    // Different date → keep the existing "move to date" flow.
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

  const handleAddManual = () => {
    const errs: Record<string, string> = {};
    if (!manualForm.description.trim()) errs.description = "Description is required";
    else if (manualForm.description.length > DESC_MAX) errs.description = `Maximum ${DESC_MAX} characters`;
    const amtErr = validateAmount(manualForm.amount);
    if (amtErr) errs.amount = amtErr;
    else if (parseFloat(manualForm.amount) <= 0) errs.amount = "Amount must be greater than zero";
    if (!manualForm.transactionDate) errs.transactionDate = "Date is required";
    setManualErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const amount = parseFloat(manualForm.amount);
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
        setManualErrors({});
        toast({ title: "Entry added" });
      },
      onError: () => toast({ title: "Failed to add entry", variant: "destructive" }),
    });
  };

  const handleSyncBalance = () => {
    const errs: Record<string, string> = {};
    const amtErr = validateAmount(syncForm.actualBalance);
    if (amtErr) errs.actualBalance = amtErr;
    if (!syncForm.syncDate) errs.syncDate = "Date is required";
    else if (syncForm.syncDate > todayStr) errs.syncDate = "Use today or a past date";
    else if (syncForm.syncDate < startDate) errs.syncDate = "Must be within the last 30 days";
    setSyncErrors(errs);
    if (Object.keys(errs).length > 0) return;
    syncBalance.mutate({ data: { actualBalance: parseFloat(syncForm.actualBalance), syncDate: syncForm.syncDate } }, {
      onSuccess: (result) => {
        invalidate();
        queryClient.invalidateQueries({ queryKey: getListBalanceSyncsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUserSettingsQueryKey() });
        setSyncResult(result);
      },
      onError: () => toast({ title: "Failed to update balance", variant: "destructive" }),
    });
  };

  const openSyncModal = () => {
    setSyncResult(null);
    setSyncErrors({});
    // Pre-populate with the current starting balance so it can be adjusted.
    setSyncForm({ actualBalance: startingBalance !== 0 ? String(startingBalance) : "", syncDate: todayStr });
    setShowSyncModal(true);
  };

  // ── Full row edit (opens on row click) ────────────────────────────────────
  const openTx = (tx: TxRow) => {
    setSelectedTx(tx);
    setEditErrors({});
    setEditForm({
      transactionDate: tx.transactionDate,
      description: tx.description,
      category: tx.category,
      transactionType: tx.transactionType,
      amount: String(tx.amount),
      notes: tx.notes ?? "",
      isActual: tx.isActual,
    });
  };

  const saveTxEdit = (id: number, data: Record<string, unknown>) => {
    updateTx.mutate({ id, data }, {
      onSuccess: () => {
        invalidate();
        setSelectedTx(null);
        setRecurringPrompt(null);
        toast({ title: "Transaction updated" });
      },
      onError: () => toast({ title: "Failed to update", variant: "destructive" }),
    });
  };

  const handleSaveEdit = () => {
    if (!selectedTx) return;
    const errs: Record<string, string> = {};
    if (!editForm.description.trim()) errs.description = "Description is required";
    else if (editForm.description.length > DESC_MAX) errs.description = `Maximum ${DESC_MAX} characters`;
    const amtErr = validateAmount(editForm.amount);
    if (amtErr) errs.amount = amtErr;
    if (!editForm.transactionDate) errs.transactionDate = "Date is required";
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) return;
    // TC-F12: cannot flip a future-dated row to Paid.
    if (editForm.isActual && !selectedTx.isActual && editForm.transactionDate > todayStr) {
      setFuturePaidDate(editForm.transactionDate);
      return;
    }
    const amount = parseFloat(editForm.amount);
    const data: Record<string, unknown> = {
      transactionDate: editForm.transactionDate,
      description: editForm.description.trim(),
      category: editForm.category,
      transactionType: editForm.transactionType,
      amount,
      notes: editForm.notes.trim() === "" ? null : editForm.notes.trim(),
      isActual: editForm.isActual,
    };
    if (editForm.isActual) data.status = null;
    if (selectedTx.forecastedAmount == null && amount !== selectedTx.amount) {
      data.forecastedAmount = selectedTx.amount;
    }
    // Recurring bill/paycheck rows: ask whether to apply shared changes to
    // all future occurrences too.
    const isRecurring = selectedTx.sourceBillId != null || selectedTx.sourcePayId != null;
    const changedShared =
      amount !== selectedTx.amount ||
      editForm.description.trim() !== selectedTx.description ||
      editForm.category !== selectedTx.category;
    if (isRecurring && changedShared) {
      setRecurringPrompt({ id: selectedTx.id, data });
      return;
    }
    saveTxEdit(selectedTx.id, data);
  };

  // ── Export ────────────────────────────────────────────────────────────────
  const typeLabel = (t: TxRow) =>
    t.sourceBalanceSyncId != null ? "Balance Update"
    : t.transactionType === "income" ? "Income"
    : t.sourceLifeEventId != null ? "Life Event"
    : t.sourceBillId != null ? "Bill"
    : "Manual Entry";

  // Respects the active time range, category filter, and search.
  const exportRows = () => filtered.map((t) => ({
    Date: t.transactionDate,
    Description: t.description,
    Category: t.category,
    Type: typeLabel(t),
    Amount: t.sourceBalanceSyncId != null ? t.amount : t.transactionType === "income" ? t.amount : -t.amount,
    "Running Balance": Math.round(t.runningBalance * 100) / 100,
  }));

  const EXPORT_HEADERS = ["Date", "Description", "Category", "Type", "Amount", "Running Balance"] as const;

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const esc = (v: string | number) =>
      typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [
      EXPORT_HEADERS.join(","),
      ...exportRows().map((r) => EXPORT_HEADERS.map((h) => esc(r[h])).join(",")),
    ];
    downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), `forecast-${todayStr}.csv`);
    toast({ title: "CSV downloaded" });
  };

  const handleExportXlsx = async () => {
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.json_to_sheet(exportRows(), { header: [...EXPORT_HEADERS] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Forecast");
    XLSX.writeFile(wb, `forecast-${todayStr}.xlsx`);
    toast({ title: "Excel file downloaded" });
  };

  const handleCopyTsv = async () => {
    const lines = [
      EXPORT_HEADERS.join("\t"),
      ...exportRows().map((r) => EXPORT_HEADERS.map((h) => String(r[h])).join("\t")),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast({ title: "Copied to clipboard", description: "Paste directly into Google Sheets or Excel." });
    } catch {
      toast({ title: "Could not access the clipboard", variant: "destructive" });
    }
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

        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={openSyncModal}>
          <Scale className="h-3.5 w-3.5 mr-1" /> Update Current Balance
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setShowManualModal(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Entry
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 text-xs">
              <Download className="h-3.5 w-3.5 mr-1" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleExportCsv}>
              <FileText className="h-3.5 w-3.5 mr-2" /> Download as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleExportXlsx}>
              <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Download as Excel (.xlsx)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyTsv}>
              <ClipboardCopy className="h-3.5 w-3.5 mr-2" /> Copy to Clipboard
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
              onClick={openSyncModal}>
              Update Current Balance
            </Button>
          </div>
        )}
        {!loadingSettings && startingBalance !== 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Balance seeded from{" "}
              <span className="text-foreground font-mono font-medium"><FormatCurrency amount={startingBalance} /></span>
              {" "}as of {userSettings?.balanceAsOfDate ?? "—"}.
              {lastSync && (
                <span className="ml-2 inline-flex items-center gap-1 text-sky-700">
                  <RefreshCcw className="h-3 w-3" />
                  Last synced {format(new Date(lastSync.syncDate + "T00:00:00"), "MMM d, yyyy")}
                  {lastSync.variance !== 0 && (
                    <>
                      {" — variance "}
                      <span className="font-mono">
                        {lastSync.variance > 0 ? "+" : "−"}<FormatCurrency amount={Math.abs(lastSync.variance)} />
                      </span>
                    </>
                  )}
                </span>
              )}
            </span>
            <button className="underline underline-offset-2 hover:text-foreground"
              onClick={openSyncModal}>
              Update Current Balance
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
                          const isAdjustment = tx.sourceBalanceSyncId != null;
                          const isMissed  = tx.status === "missed";
                          const isManual  = !tx.sourceBillId && !tx.sourcePayId && !isAdjustment;
                          const isEditing = editingId === tx.id;
                          const isToday   = tx.transactionDate === todayStr;
                          const isPast    = tx.transactionDate < todayStr;
                          const isOverdue = isPast && !tx.isActual && !isMissed && !isAdjustment;
                          const isCurrentBalance = tx.id === currentBalanceTxId;
                          const variance = tx.isActual && tx.forecastedAmount != null && tx.forecastedAmount !== tx.amount
                            ? tx.amount - tx.forecastedAmount
                            : null;

                          return (
                            <Fragment key={tx.id}>
                            {hasPastRows && tx.id === firstFutureTxId && (
                              <div className="flex items-center gap-3 px-4 py-1.5 bg-primary/[0.06] border-y border-primary/25 select-none">
                                <div className="h-px flex-1 bg-primary/25" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-primary">Today</span>
                                <div className="h-px flex-1 bg-primary/25" />
                              </div>
                            )}
                            <div
                              draggable={!isEditing && !isAdjustment}
                              onDragStart={(e) => { if (isAdjustment) { e.preventDefault(); return; } handleRowDragStart(tx, e); }}
                              onDragOver={(e) => handleRowDragOver(tx, e)}
                              onDrop={(e) => handleRowDrop(tx, e)}
                              onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                              onClick={() => { if (!isEditing && !suppressClickRef.current) openTx(tx); }}
                              className={[
                                "relative grid grid-cols-[110px_1fr_130px_72px_136px_230px] border-b border-border/60 last:border-0 group cursor-pointer transition-colors select-none",
                                idx % 2 === 1 ? "bg-muted/20" : "",
                                isPast ? "opacity-60" : "",
                                draggingId === tx.id ? "opacity-40" : "",
                                draggingId !== null && draggingId !== tx.id && draggedRow?.transactionDate !== tx.transactionDate ? "hover:border-primary hover:border-2" : "",
                                isNeg
                                  ? "bg-red-500/[0.06] hover:bg-red-500/[0.12]"
                                  : isAdjustment
                                  ? "bg-sky-500/[0.06] hover:bg-sky-500/[0.12]"
                                  : "hover:bg-muted/40",
                              ].join(" ")}
                            >
                              {dragOver?.id === tx.id && (
                                <div
                                  className={`absolute left-0 right-0 h-0.5 bg-primary z-20 pointer-events-none ${dragOver.pos === "before" ? "-top-px" : "-bottom-px"}`}
                                />
                              )}
                              {/* Date */}
                              <div className="px-4 py-2.5 flex items-center gap-1.5">
                                <GripVertical
                                  aria-label="Drag to move this transaction to another date"
                                  className="h-3.5 w-3.5 shrink-0 -ml-2 text-muted-foreground/25 group-hover:text-muted-foreground/70 cursor-grab"
                                />
                                <span className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                  {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d, yyyy")}
                                </span>
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
                                {isToday && (
                                  <Badge className="shrink-0 text-[9px] font-bold px-1.5 h-4 bg-primary/20 text-primary border-0 rounded-full leading-none">TODAY</Badge>
                                )}
                                {tx.isActual && (
                                  <Badge className="shrink-0 text-[9px] px-1.5 h-4 bg-primary/20 text-primary border-0 rounded-full leading-none">Paid</Badge>
                                )}
                                {isOverdue && (
                                  <Badge className="shrink-0 flex items-center gap-1 text-[9px] px-1.5 h-4 bg-orange-100 text-orange-700 border-0 rounded-full leading-none">
                                    <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                                    Overdue
                                  </Badge>
                                )}
                                {isMissed && (
                                  <Badge className="shrink-0 flex items-center gap-1 text-[9px] px-1.5 h-4 bg-orange-100 text-orange-700 border-0 rounded-full leading-none">
                                    <X className="h-2.5 w-2.5" />
                                    Missed
                                  </Badge>
                                )}
                                {isManual && !isAdjustment && (
                                  <Badge className="shrink-0 text-[9px] px-1.5 h-4 bg-muted text-muted-foreground border-0 rounded-full leading-none">Manual</Badge>
                                )}
                                {isAdjustment && (
                                  <Badge className="shrink-0 flex items-center gap-1 text-[9px] px-1.5 h-4 bg-sky-100 text-sky-700 border-0 rounded-full leading-none">
                                    <RefreshCcw className="h-2.5 w-2.5" />
                                    Balance Update
                                  </Badge>
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
                                <span className={`text-[11px] font-medium ${isAdjustment ? "text-sky-600" : tx.transactionType === "income" ? "text-emerald-400" : tx.sourceLifeEventId != null ? "text-teal-600" : "text-zinc-400"}`}>
                                  {isAdjustment ? "Balance Update" : tx.transactionType === "income" ? "Income" : tx.sourceLifeEventId != null ? "Life Event" : "Bill"}
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
                                  <div className="flex flex-col items-end">
                                    <span
                                      className={`font-mono text-sm ${isMissed ? "line-through text-muted-foreground" : isAdjustment ? "text-sky-600" : tx.transactionType === "income" ? "text-emerald-400" : tx.sourceLifeEventId != null ? "text-teal-600" : "text-foreground"}`}
                                      title={
                                        isAdjustment
                                          ? "Balance update — the running balance is set to this value here"
                                          : tx.isVariable
                                          ? "This is an estimate — your actual bill may vary"
                                          : tx.isActual
                                          ? "Locked — already paid"
                                          : "Double-click to edit"
                                      }
                                    >
                                      {tx.isVariable && !isAdjustment && <span className="text-muted-foreground mr-0.5">~</span>}
                                      {!isAdjustment && (tx.transactionType === "income" ? "+" : "−")}
                                      <FormatCurrency amount={tx.amount} />
                                    </span>
                                    {variance !== null && (
                                      <span className="text-[10px] font-mono text-muted-foreground">
                                        {variance > 0 ? "+" : "−"}<FormatCurrency amount={Math.abs(variance)} /> vs planned
                                      </span>
                                    )}
                                  </div>
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
                                  {!tx.isActual && !isMissed && !isAdjustment && tx.transactionType === "expense" && (
                                    <button
                                      title="Mark as paid"
                                      onClick={() => handleMarkPaid(tx)}
                                      className="text-muted-foreground/60 hover:text-emerald-400 transition-colors"
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {!tx.isActual && !isMissed && !isAdjustment && tx.transactionType === "expense" && tx.transactionDate <= todayStr && (
                                    <button
                                      title="Mark as missed"
                                      onClick={() => handleMarkMissed(tx)}
                                      className="text-muted-foreground/60 hover:text-orange-500 transition-colors"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {!tx.isActual && !isMissed && !isAdjustment && tx.transactionType === "income" && tx.transactionDate <= todayStr && (
                                    <button
                                      title="Confirm received"
                                      onClick={() => handleMarkPaid(tx)}
                                      className="text-muted-foreground/60 hover:text-emerald-400 transition-colors"
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {isMissed && (
                                    <button
                                      title="Undo missed"
                                      onClick={() => handleUnmarkMissed(tx)}
                                      className="text-muted-foreground/60 hover:text-foreground transition-colors"
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
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
                            </Fragment>
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

              {summaryRows.map((g) => {
                const expanded = expandedMonths.has(g.key);
                const net = g.income - g.expenses;
                return (
                  <div key={g.key} className="border-b border-border last:border-0">
                    {/* Summary row */}
                    <div
                      className="grid grid-cols-[1fr_130px_130px_130px_148px] cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => toggleMonth(g.key)}
                    >
                      <div className="px-4 py-3 flex items-center gap-2">
                        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
                        <span className="font-medium text-sm">{g.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {g.rows.length} items
                        </span>
                      </div>
                      <div className="px-4 py-3 text-right font-mono text-sm text-emerald-400">
                        {g.income > 0 ? <FormatCurrency amount={g.income} /> : <span className="text-muted-foreground/30">—</span>}
                      </div>
                      <div className="px-4 py-3 text-right font-mono text-sm text-muted-foreground">
                        {g.expenses > 0 ? <FormatCurrency amount={g.expenses} /> : <span className="text-muted-foreground/30">—</span>}
                      </div>
                      <div className={`px-4 py-3 text-right font-mono text-sm font-semibold ${net >= 0 ? "text-emerald-400" : "text-destructive"}`}>
                        {net >= 0 ? "+" : ""}<FormatCurrency amount={net} />
                      </div>
                      <div className={`px-4 py-3 text-right font-mono text-sm font-bold ${g.endBalance < 0 ? "text-destructive" : "text-foreground"}`}>
                        <FormatCurrency amount={g.endBalance} />
                      </div>
                    </div>

                    {/* Expanded sub-rows */}
                    {expanded && (
                      <div className="border-t border-border/40 bg-background/40">
                        {g.rows.map((tx) => (
                          <div
                            key={tx.id}
                            className="grid grid-cols-[1fr_130px_130px_130px_148px] border-b border-border/30 last:border-0 hover:bg-muted/20 cursor-pointer"
                            onClick={() => openTx(tx)}
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
          UPDATE CURRENT BALANCE MODAL
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={showSyncModal} onOpenChange={(open) => { setShowSyncModal(open); if (!open) setSyncResult(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update Current Balance</DialogTitle>
          </DialogHeader>

          {!syncResult ? (
            <>
              <div className="space-y-3 py-1">
                <p className="text-sm text-muted-foreground">
                  Check your bank app and enter your real account balance. A Balance Update row is added on that date and every later row recalculates from it.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Current balance</label>
                    <div className="relative mt-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                      <Input
                        value={syncForm.actualBalance}
                        onChange={(e) => setSyncForm((f) => ({ ...f, actualBalance: e.target.value }))}
                        className="pl-7 font-mono"
                        placeholder="0.00"
                        inputMode="decimal"
                        onKeyDown={(e) => { if (e.key === "Enter") handleSyncBalance(); }}
                        autoFocus
                      />
                    </div>
                    <FieldError msg={syncErrors.actualBalance} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">As of date</label>
                    <Input
                      type="date"
                      value={syncForm.syncDate}
                      max={todayStr}
                      onChange={(e) => setSyncForm((f) => ({ ...f, syncDate: e.target.value }))}
                      className="mt-1"
                    />
                    <FieldError msg={syncErrors.syncDate} />
                  </div>
                </div>
                {lastSync && (
                  <p className="text-xs text-muted-foreground">
                    Last updated {format(new Date(lastSync.syncDate + "T00:00:00"), "MMM d, yyyy")}
                    {lastSync.variance !== 0 && (
                      <> — variance was {lastSync.variance > 0 ? "+" : "−"}<FormatCurrency amount={Math.abs(lastSync.variance)} /></>
                    )}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowSyncModal(false)}>Cancel</Button>
                <Button onClick={handleSyncBalance} disabled={syncBalance.isPending}>
                  {syncBalance.isPending ? "Saving…" : "Update Balance"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="space-y-3 py-1">
                {syncResult.variance === 0 ? (
                  <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <Check className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
                    <p className="text-sm text-emerald-800">
                      You're right on track. Your actual balance matches the forecast exactly.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3">
                    <RefreshCcw className="h-4 w-4 mt-0.5 text-sky-600 shrink-0" />
                    <p className="text-sm text-sky-800">
                      Your actual balance is{" "}
                      <span className="font-mono font-semibold"><FormatCurrency amount={Math.abs(syncResult.variance)} /></span>{" "}
                      {syncResult.variance > 0 ? "higher" : "lower"} than forecasted. A Balance Update row was added on{" "}
                      {format(new Date(syncResult.syncDate + "T00:00:00"), "MMM d, yyyy")} so your projections now start from your real balance.
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border border-border px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">Forecasted</div>
                    <div className="font-mono font-semibold">
                      {syncResult.forecastedBalance < 0 && "−"}
                      <FormatCurrency amount={Math.abs(syncResult.forecastedBalance)} />
                    </div>
                  </div>
                  <div className="rounded-md border border-border px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">Actual</div>
                    <div className="font-mono font-semibold">
                      {syncResult.actualBalance < 0 && "−"}
                      <FormatCurrency amount={Math.abs(syncResult.actualBalance)} />
                    </div>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => { setShowSyncModal(false); setSyncResult(null); }}>Done</Button>
              </DialogFooter>
            </>
          )}
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
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <CharCount value={manualForm.description} max={DESC_MAX} />
              </div>
              <Input
                value={manualForm.description}
                maxLength={DESC_MAX}
                onChange={(e) => setManualForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g., Vacation trip deposit"
                className="mt-1"
                autoFocus
              />
              <FieldError msg={manualErrors.description} />
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
                    inputMode="decimal"
                    className="pl-7 font-mono"
                  />
                </div>
                <FieldError msg={manualErrors.amount} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Date</label>
                <Input
                  type="date"
                  value={manualForm.transactionDate}
                  onChange={(e) => setManualForm((f) => ({ ...f, transactionDate: e.target.value }))}
                  className="mt-1"
                />
                <FieldError msg={manualErrors.transactionDate} />
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
          TRANSACTION EDIT SHEET
      ══════════════════════════════════════════════════════════════════════ */}
      <Sheet open={!!selectedTx} onOpenChange={(open) => { if (!open) setSelectedTx(null); }}>
        <SheetContent className="w-80 sm:w-[380px] flex flex-col gap-0">
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle className="text-base">
              {selectedTx?.sourceBalanceSyncId != null ? "Balance Update" : "Edit Transaction"}
            </SheetTitle>
          </SheetHeader>
          {selectedTx && selectedTx.sourceBalanceSyncId != null && (
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Date</div>
                  <div className="font-mono">{format(new Date(selectedTx.transactionDate + "T00:00:00"), "MMMM d, yyyy")}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Balance set to</div>
                  <div className="font-mono font-semibold text-base text-sky-600">
                    <FormatCurrency amount={selectedTx.amount} />
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                This row sets the running balance to the value above; every later row calculates forward from it.
                It cannot be edited or deleted. To change it, use "Update Current Balance" again for the same date.
              </p>
            </div>
          )}
          {selectedTx && selectedTx.sourceBalanceSyncId == null && (
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Description</label>
                  <CharCount value={editForm.description} max={DESC_MAX} />
                </div>
                <Input
                  value={editForm.description}
                  maxLength={DESC_MAX}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                  className="mt-1"
                />
                <FieldError msg={editErrors.description} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Date</label>
                  <Input
                    type="date"
                    value={editForm.transactionDate}
                    onChange={(e) => setEditForm((f) => ({ ...f, transactionDate: e.target.value }))}
                    className="mt-1"
                  />
                  <FieldError msg={editErrors.transactionDate} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Amount</label>
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                    <Input
                      value={editForm.amount}
                      inputMode="decimal"
                      onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                      className="pl-7 font-mono"
                    />
                  </div>
                  <FieldError msg={editErrors.amount} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Category</label>
                  <Select value={editForm.category} onValueChange={(v) => setEditForm((f) => ({ ...f, category: v }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {!MANUAL_CATEGORIES.includes(editForm.category) && editForm.category !== "salary" && (
                        <SelectItem value={editForm.category}>{editForm.category}</SelectItem>
                      )}
                      <SelectItem value="salary">Salary</SelectItem>
                      {MANUAL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Type</label>
                  <Select value={editForm.transactionType} onValueChange={(v) => setEditForm((f) => ({ ...f, transactionType: v }))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="expense">
                        {selectedTx.sourceLifeEventId != null ? "Life Event (expense)" : selectedTx.sourceBillId != null ? "Bill (expense)" : "Expense"}
                      </SelectItem>
                      <SelectItem value="income">Income</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Notes</label>
                <Textarea
                  value={editForm.notes}
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional notes…"
                  className="mt-1 min-h-[72px] text-sm"
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium">
                    {editForm.transactionType === "income" ? "Confirmed received" : "Paid"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {editForm.transactionDate > todayStr
                      ? "Only available for today or past dates"
                      : "Locks the amount as the actual value"}
                  </div>
                </div>
                <Switch
                  checked={editForm.isActual}
                  disabled={editForm.transactionDate > todayStr}
                  onCheckedChange={(checked) => setEditForm((f) => ({ ...f, isActual: checked }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm pt-1">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Running Balance</div>
                  <div className={`font-mono font-bold ${selectedTx.runningBalance < 0 ? "text-destructive" : "text-foreground"}`}>
                    {selectedTx.runningBalance < 0 && "−"}
                    <FormatCurrency amount={Math.abs(selectedTx.runningBalance)} />
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Status</div>
                  <div className="text-sm">
                    {selectedTx.status === "missed"
                      ? <span className="text-orange-600">Missed</span>
                      : selectedTx.isActual
                      ? <span className="text-primary">Paid</span>
                      : selectedTx.isCommitted
                      ? <span className="text-amber-400">Committed</span>
                      : <span className="text-muted-foreground">Projected</span>
                    }
                  </div>
                </div>
              </div>

              {selectedTx.companyUrl && (
                <a
                  href={selectedTx.companyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {selectedTx.companyUrl}
                </a>
              )}

              <div className="space-y-2 pt-2">
                <Button className="w-full" onClick={handleSaveEdit} disabled={updateTx.isPending}>
                  {updateTx.isPending ? "Saving…" : "Save Changes"}
                </Button>
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

      {/* ══════════════════════════════════════════════════════════════════════
          FUTURE ROW "MARK AS PAID" BLOCKED DIALOG (TC-F12)
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={!!futurePaidDate} onOpenChange={(open) => { if (!open) setFuturePaidDate(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scheduled for a future date</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This transaction is scheduled for{" "}
            <span className="text-foreground font-medium">
              {futurePaidDate && format(new Date(futurePaidDate + "T00:00:00"), "MMMM d, yyyy")}
            </span>
            . To mark it as paid, please update the date to today or an earlier date first.
            You can edit the row directly or drag and drop it to a new date.
          </p>
          <DialogFooter>
            <Button onClick={() => setFuturePaidDate(null)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════════════════════════════════════════════════════════════════
          RECURRING EDIT SCOPE DIALOG
      ══════════════════════════════════════════════════════════════════════ */}
      <Dialog open={!!recurringPrompt} onOpenChange={(open) => { if (!open) setRecurringPrompt(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Apply to future occurrences?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This is a recurring {selectedTx?.sourcePayId != null ? "paycheck" : "bill"}. Update just this
            occurrence, or all future occurrences as well?
          </p>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={updateTx.isPending}
              onClick={() => { if (recurringPrompt) saveTxEdit(recurringPrompt.id, { ...recurringPrompt.data, applyToFuture: false }); }}
            >
              Just this one
            </Button>
            <Button
              disabled={updateTx.isPending}
              onClick={() => { if (recurringPrompt) saveTxEdit(recurringPrompt.id, { ...recurringPrompt.data, applyToFuture: true }); }}
            >
              All future occurrences
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
