import { useState, useMemo, useRef, useEffect, Fragment, type ReactNode } from "react";
import { format, addMonths, subDays } from "date-fns";
import { useLocation } from "wouter";
import {
  ExternalLink, Plus, Trash2, Check, RefreshCw, Search,
  ChevronRight, Zap, PawPrint, GripVertical, Download,
  X, RotateCcw, FileSpreadsheet, FileText, ClipboardCopy,
  TriangleAlert,
} from "lucide-react";

import { categoryMeta, categoryDisplayLabel, getCategoryEmoji } from "@/utils/categoryIcons";
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

// ─── Category color / icon system ────────────────────────────────────────────
// Shared app-wide system: see src/utils/categoryIcons.ts (single source of
// truth for icons, accent colors, and badge colors).
const catMeta = categoryMeta;
const catLabel = categoryDisplayLabel;

// Shared column definition (Part A): every row — header, month headers, data
// rows — uses this exact grid so columns align perfectly.
const LEDGER_GRID = "grid grid-cols-[3px_80px_32px_1fr_100px_120px_120px_110px] min-w-[700px]";

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

// Small status pill used inside the description cell (Part F).
function StatusPill({ bg, text, children }: { bg: string; text: string; children: ReactNode }) {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none whitespace-nowrap"
      style={{ backgroundColor: bg, color: text }}
    >
      {children}
    </span>
  );
}

// Running-balance color: red when negative, green when healthy, navy otherwise.
const balanceColor = (n: number) => (n < 0 ? "var(--color-negative)" : n >= 1000 ? "var(--color-positive)" : "var(--color-navy)");

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
  const [showHistory, setShowHistory] = useState(true);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  // inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  // deep-link highlight (#4): scroll + flash a matching ledger row
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const deepLinkDone = useRef(false);

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
  const [, navigate] = useLocation();

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

  // ── Deep-link highlight (#4) ──────────────────────────────────────────────
  // On mount, read ?tx=<id> or ?txdate=&txdesc= from the URL, scroll the
  // matching ledger row into view and flash it, then clean the query params.
  useEffect(() => {
    if (deepLinkDone.current || txsWithBalance.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const txParam = params.get("tx");
    const txDate = params.get("txdate");
    const txDesc = params.get("txdesc");
    if (!txParam && !txDate && !txDesc) return;

    let match: TxRow | undefined;
    if (txParam) {
      const id = Number(txParam);
      match = txsWithBalance.find((t) => t.id === id);
    } else if (txDate || txDesc) {
      match = txsWithBalance.find(
        (t) =>
          (!txDate || t.transactionDate === txDate) &&
          (!txDesc || t.description.toLowerCase() === txDesc.toLowerCase()),
      );
    }

    deepLinkDone.current = true;

    if (match) {
      const targetId = match.id;
      if (match.transactionDate < todayStr) setShowHistory(true);
      setHighlightId(targetId);
      setTimeout(() => {
        rowRefs.current[targetId]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 150);
      setTimeout(() => setHighlightId(null), 2200);
    }

    // Clean the query params from the URL without a navigation entry.
    window.history.replaceState(null, "", window.location.pathname);
  }, [txsWithBalance, todayStr]);

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

  // ── Hide-history toggle (visual only) ─────────────────────────────────────
  // When history is hidden, rows dated before today are dropped from the
  // ledger DISPLAY only — totals/footer/summary still use the full range.
  const displayRows = useMemo(
    () => (showHistory ? filtered : filtered.filter((t) => t.transactionDate >= todayStr)),
    [filtered, showHistory, todayStr],
  );
  const hiddenPastCount = filtered.length - displayRows.length;

  // ── Group by month ────────────────────────────────────────────────────────
  const groupByMonth = (rows: TxRow[]): MonthGroup[] => {
    const map: Record<string, MonthGroup> = {};
    for (const t of rows) {
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
  };
  // Full-range groups: drive the Monthly Summary view and insights.
  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
  // Ledger groups: respect the hide-history toggle.
  const ledgerGroups = useMemo(
    () => (showHistory ? groupByMonth(filtered) : groupByMonth(displayRows)),
    [filtered, displayRows, showHistory],
  );

  // ── Unique categories for filter ──────────────────────────────────────────
  const categories = useMemo(() => {
    const s = new Set(txsWithBalance.map((t) => t.category));
    return Array.from(s).sort();
  }, [txsWithBalance]);

  // ── Summary rows ──────────────────────────────────────────────────────────
  // Derived directly from the ledger month groups so Income / Expenses / Net /
  // End Balance always match exactly what the Ledger view shows (TC-F18).
  const summaryRows = groups;

  // ── Categories visible in the current view (legend, Part L) ──────────────
  const visibleCategories = useMemo(
    () => Array.from(new Set(displayRows.map((t) => t.category))).sort((a, b) => catLabel(a).localeCompare(catLabel(b))),
    [displayRows],
  );

  // ── Balance as of today (TODAY divider + footer) ─────────────────────────
  // Computed from the FULL in-range ledger (not the filtered view) so that
  // search/category filters never change the displayed current balance.
  const currentBalanceValue = useMemo(() => {
    let val = startingBalance;
    for (const t of txsWithBalance) {
      if (t.transactionDate > todayStr) break;
      val = t.runningBalance;
    }
    return val;
  }, [txsWithBalance, startingBalance, todayStr]);

  // ── Period totals (sticky footer, Part M) ────────────────────────────────
  // Footer tracks the selected time range only — search/category filters do
  // not change these numbers. Mirrors the month-group exclusion rules:
  // balance updates and missed rows never count toward income/expenses.
  const periodTotals = useMemo(() => {
    let income = 0;
    let expenses = 0;
    const monthKeys = new Set<string>();
    for (const t of txsWithBalance) {
      monthKeys.add(t.transactionDate.slice(0, 7));
      if (t.sourceBalanceSyncId == null && t.status !== "missed") {
        if (t.transactionType === "income") income += t.amount;
        else expenses += t.amount;
      }
    }
    const n = Math.max(monthKeys.size, 1);
    return { net: income - expenses, monthlyIncome: income / n, monthlyBills: expenses / n };
  }, [txsWithBalance]);

  // ── Otis insight rows (Part I) — derived, presentation-only ──────────────
  type Insight = { key: string; body: ReactNode; prompt: string };
  const insightsByMonth = useMemo(() => {
    const out: Record<string, Insight[]> = {};
    const money = (n: number) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(n));
    const strong = (s: string, k: string) => <b key={k} style={{ color: "var(--color-navy)" }}>{s}</b>;
    for (const g of groups) {
      const list: Insight[] = [];

      // 1. Running balance goes negative this month.
      const firstNeg = g.rows.find((t) => t.runningBalance < 0);
      if (firstNeg) {
        const d = format(new Date(firstNeg.transactionDate + "T00:00:00"), "MMMM d");
        // Next paycheck after the dip → a concrete, actionable suggestion.
        const nextPay = txsWithBalance.find(
          (t) => t.transactionType === "income" && t.sourceBalanceSyncId == null && t.transactionDate > firstNeg.transactionDate,
        );
        const suggestion = nextPay
          ? <> Consider shifting it until after your paycheck on {strong(format(new Date(nextPay.transactionDate + "T00:00:00"), "MMMM d"), "c")}.</>
          : <> Moving a bill or shifting some savings could cover the gap.</>;
        list.push({
          key: `${g.key}-neg`,
          body: (
            <>Heads up — your {strong(firstNeg.description, "d")} on {strong(d, "b")} pushes your balance to{" "}
            {strong(`−${money(firstNeg.runningBalance)}`, "a")}.{suggestion}</>
          ),
          prompt: `My cash flow forecast shows "${firstNeg.description}" on ${d} pushing my balance negative (−${money(firstNeg.runningBalance)}). What are my options to avoid that?`,
        });
      }

      // 2. Three or more large bills (≥ $500) landing in the same 7-day window.
      const large = g.rows.filter(
        (t) => t.transactionType === "expense" && t.sourceBalanceSyncId == null && t.status !== "missed" && t.amount >= 500,
      );
      let cluster: TxRow[] | null = null;
      for (const anchor of large) {
        const end = new Date(anchor.transactionDate + "T00:00:00");
        end.setDate(end.getDate() + 6);
        const endStr = format(end, "yyyy-MM-dd");
        const win = large.filter((t) => t.transactionDate >= anchor.transactionDate && t.transactionDate <= endStr);
        if (win.length >= 3 && (!cluster || win.length > cluster.length)) cluster = win;
      }
      if (cluster) {
        const total = cluster.reduce((s, t) => s + t.amount, 0);
        const from = format(new Date(cluster[0].transactionDate + "T00:00:00"), "MMM d");
        const to = format(new Date(cluster[cluster.length - 1].transactionDate + "T00:00:00"), "MMM d");
        list.push({
          key: `${g.key}-cluster`,
          body: (
            <>{strong(`${cluster.length} large bills`, "a")} totaling {strong(money(total), "b")} land between {from} and{" "}
            {to}. That's a heavy week — spacing them out could ease the squeeze.</>
          ),
          prompt: `I have ${cluster.length} large bills totaling ${money(total)} due between ${from} and ${to}. How should I manage that week?`,
        });
      }

      // 3. Life-event spending materially impacts this month's cash flow.
      const lifeTotal = g.rows
        .filter((t) => t.sourceLifeEventId != null && t.transactionType === "expense" && t.status !== "missed")
        .reduce((s, t) => s + t.amount, 0);
      if (lifeTotal >= 1000) {
        list.push({
          key: `${g.key}-life`,
          body: (
            <>Life event spending adds {strong(money(lifeTotal), "a")} to {g.label}&apos;s outflows — a noticeable dent
            in this month&apos;s cash flow.</>
          ),
          prompt: `Life events add ${money(lifeTotal)} of spending in ${g.label}. How will this impact my cash flow, and should I adjust anything?`,
        });
      }

      if (list.length) out[g.key] = list;
    }
    return out;
  }, [groups, txsWithBalance]);

  const askOtis = (prompt: string) => navigate(`/otis?prompt=${encodeURIComponent(prompt)}`);

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
    // UTF-8 BOM keeps Excel happy and avoids antivirus false-positives on the blob.
    downloadBlob(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), `forecast-${todayStr}.csv`);
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

  // When searching, auto-expand every month that contains matching rows so the
  // Monthly Summary view surfaces the matches directly (TC via spec #11).
  const groupKeysStr = groups.map((g) => g.key).join(",");
  useEffect(() => {
    if (search.trim()) {
      setExpandedMonths(new Set(groupKeysStr ? groupKeysStr.split(",") : []));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, groupKeysStr]);

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

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div className="px-6 pt-6 pb-4">
        <h1 className="text-2xl font-bold tracking-tight">Forecast</h1>
        <p className="text-muted-foreground mt-1">Your complete financial picture, month by month</p>
      </div>

      {/* ── Controls Bar ─────────────────────────────────────────────────────── */}
      <div className="sticky top-[57px] z-20 bg-background/95 backdrop-blur-sm border-b border-border px-6 py-3 flex items-center gap-2 flex-wrap">

        {/* Time range pill group (active: navy) */}
        <div className="flex items-center gap-1.5">
          {([1, 3, 6, 12] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`rounded-[20px] px-[13px] py-[5px] text-xs font-medium transition-colors duration-100 ${months === m ? "text-white" : "bg-white border border-[#E3E7ED] text-gray-500 hover:text-gray-800 hover:border-gray-300"}`}
              style={months === m ? { backgroundColor: "#0D2B45" } : undefined}
            >
              {m}mo
            </button>
          ))}
        </div>

        {/* Hide/Show history toggle — navy active style when history is hidden */}
        <button
          onClick={() => setShowHistory((v) => !v)}
          className={`rounded-[20px] px-[13px] py-[5px] text-xs font-medium transition-colors duration-100 whitespace-nowrap ${showHistory ? "bg-white border border-[#E3E7ED] text-gray-500 hover:text-gray-800 hover:border-gray-300" : "text-white"}`}
          style={!showHistory ? { backgroundColor: "#0D2B45" } : undefined}
        >
          {showHistory ? "Hide history" : "Show history"}
        </button>

        {/* View toggle pill group (active: carolina) */}
        <div className="flex items-center gap-1.5 ml-1">
          {(["ledger", "summary"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-[20px] px-[13px] py-[5px] text-xs font-medium transition-colors duration-100 ${view === v ? "text-white" : "bg-white border border-[#E3E7ED] text-gray-500 hover:text-gray-800 hover:border-gray-300"}`}
              style={view === v ? { backgroundColor: "var(--color-carolina)" } : undefined}
            >
              {v === "ledger" ? "Ledger" : "Monthly Summary"}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="h-8 text-xs w-32 bg-card border-border">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => <SelectItem key={c} value={c}>{catLabel(c)}</SelectItem>)}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search transactions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs pl-8 w-44 bg-card border-border"
          />
        </div>

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
        <Button
          size="sm"
          className="h-8 text-xs text-primary-foreground bg-primary hover:bg-primary/90"
          onClick={() => setShowManualModal(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Entry
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={openSyncModal}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Update Current Balance
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-8 px-0"
          title="Regenerate forecast"
          aria-label="Regenerate forecast"
          onClick={handleRegenerate}
          disabled={regenerate.isPending}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${regenerate.isPending ? "animate-spin" : ""}`} />
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
                  <RefreshCw className="h-3 w-3" />
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
            {!showHistory && hiddenPastCount > 0 && (
              <div className="text-[11px] text-muted-foreground">
                Showing from today · {hiddenPastCount} past row{hiddenPastCount !== 1 ? "s" : ""} hidden
              </div>
            )}
            {ledgerGroups.length === 0 ? (
              <div className="py-20 text-center text-muted-foreground border border-border rounded-lg">
                <Zap className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No transactions in this range.</p>
                <p className="text-sm mt-1">Try a longer time range or regenerate the forecast.</p>
              </div>
            ) : (
              <div className="bg-white border border-[#E8ECF0] rounded-[14px] overflow-hidden">
                {/* Scrollable ledger with its own sticky context */}
                <div className="overflow-auto max-h-[calc(100vh-330px)]">

                  {/* Column headers (Part N) — same grid as every row */}
                  <div className={`sticky top-0 z-10 ${LEDGER_GRID} bg-[#F5F7FA] border-b border-[#EEF1F5] text-[11px] font-semibold text-[#AAB0BB] uppercase tracking-[0.05em]`}>
                    <div />
                    <div className="px-1 py-2.5">Date</div>
                    <div />
                    <div className="px-2 py-2.5">Description</div>
                    <div className="px-2 py-2.5 text-right">Amount</div>
                    <div className="px-2 py-2.5 text-right">Category</div>
                    <div className="px-2 py-2.5 text-right">Balance</div>
                    <div className="px-3 py-2.5 text-right">Actions</div>
                  </div>

                  {/* Month groups */}
                  {ledgerGroups.map((group) => {
                    const monthInsights = insightsByMonth[group.key] ?? [];
                    return (
                      <div key={group.key}>
                        {/* Month divider — clean centered chapter break */}
                        <div className="flex items-center gap-3" style={{ padding: "10px 18px" }}>
                          <div className="flex-1 h-px" style={{ backgroundColor: "#E2E8F0" }} />
                          <span className="text-[12px] font-semibold tracking-[0.04em]" style={{ color: "#0D2B45" }}>
                            {group.label}
                          </span>
                          <div className="flex-1 h-px" style={{ backgroundColor: "#E2E8F0" }} />
                        </div>

                        {/* Transaction rows */}
                        {group.rows.map((tx, idx) => {
                          const isNeg     = tx.runningBalance < 0;
                          const isAdjustment = tx.sourceBalanceSyncId != null;
                          const isMissed  = tx.status === "missed";
                          const isManual  = !tx.sourceBillId && !tx.sourcePayId && !isAdjustment;
                          const isEditing = editingId === tx.id;
                          const isPast    = tx.transactionDate < todayStr;
                          const isOverdue = isPast && !tx.isActual && !isMissed && !isAdjustment;
                          const isCurrentBalance = tx.id === currentBalanceTxId;
                          const isLifeEvent = tx.sourceLifeEventId != null;
                          const meta = catMeta(tx.category);
                          const variance = tx.isActual && tx.forecastedAmount != null && tx.forecastedAmount !== tx.amount
                            ? tx.amount - tx.forecastedAmount
                            : null;

                          return (
                            <Fragment key={tx.id}>
                            {hasPastRows && tx.id === firstFutureTxId && (
                              <div
                                className="flex items-center justify-between gap-3 px-4 py-1.5 select-none"
                                style={{ backgroundColor: "var(--color-carolina-muted)", borderTop: "2px solid var(--color-carolina)", borderBottom: "2px solid var(--color-carolina)" }}
                              >
                                <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: "var(--color-carolina)" }}>
                                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: "var(--color-carolina)" }} />
                                  Today — {format(today, "MMMM d, yyyy")}
                                </span>
                                <span className="text-xs font-semibold font-mono tabular-nums whitespace-nowrap" style={{ color: "var(--color-navy)" }}>
                                  Current balance {currentBalanceValue < 0 && "−"}<FormatCurrency amount={Math.abs(currentBalanceValue)} />
                                </span>
                              </div>
                            )}
                            <div
                              ref={(el) => { rowRefs.current[tx.id] = el; }}
                              draggable={!isEditing && !isAdjustment}
                              onDragStart={(e) => { if (isAdjustment) { e.preventDefault(); return; } handleRowDragStart(tx, e); }}
                              onDragOver={(e) => handleRowDragOver(tx, e)}
                              onDrop={(e) => handleRowDrop(tx, e)}
                              onDragEnd={() => { setDraggingId(null); setDragOver(null); }}
                              onClick={() => { if (!isEditing && !suppressClickRef.current) openTx(tx); }}
                              className={[
                                `relative ${LEDGER_GRID} min-h-[44px] border-b border-[#F2F4F7] last:border-0 group cursor-pointer transition-colors duration-100 select-none`,
                                tx.id === highlightId ? "animate-flash-highlight" : "",
                                isPast ? "opacity-[0.72]" : "",
                                draggingId === tx.id ? "opacity-40" : "",
                                draggingId !== null && draggingId !== tx.id && draggedRow?.transactionDate !== tx.transactionDate ? "hover:border-primary hover:border-2" : "",
                                isNeg
                                  ? "bg-[#FFF5F5] hover:bg-[#FFECEC]"
                                  : isAdjustment
                                  ? "bg-[#F3F9FE] hover:bg-[#E9F3FC]"
                                  : idx % 2 === 1
                                  ? "bg-[#FAFBFC] hover:bg-[#F8FAFE]"
                                  : "bg-white hover:bg-[#F8FAFE]",
                              ].join(" ")}
                            >
                              {/* Category color bar (Part C) — first grid cell */}
                              <div style={{ backgroundColor: meta.color }} />
                              {dragOver?.id === tx.id && (
                                <div
                                  className={`absolute left-0 right-0 h-0.5 bg-carolina z-20 pointer-events-none ${dragOver.pos === "before" ? "-top-px" : "-bottom-px"}`}
                                />
                              )}
                              {/* Date */}
                              <div className="px-1 py-[11px] flex items-center gap-0.5 min-w-0">
                                <GripVertical
                                  aria-label="Drag to move this transaction to another date"
                                  className="h-3 w-3 shrink-0 text-muted-foreground/25 group-hover:text-muted-foreground/70 cursor-grab"
                                />
                                <span className="font-mono tabular-nums text-[12px] whitespace-nowrap" style={{ color: "#999" }}>
                                  {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d")}
                                </span>
                              </div>

                              {/* Category icon (Part D) — emoji, vertically centered */}
                              <div
                                className="py-[11px] flex items-center justify-center"
                                style={{ fontSize: "16px", lineHeight: 1 }}
                              >
                                {getCategoryEmoji(tx.category, tx.description)}
                              </div>

                              {/* Description + status badges (Part F) */}
                              <div className="px-2 py-[11px] flex items-center gap-1.5 min-w-0">
                                <span
                                  className={`font-medium text-[13px] truncate min-w-0 ${isMissed ? "line-through text-muted-foreground" : ""}`}
                                  style={isMissed ? undefined : { color: "#1A1A2E" }}
                                >
                                  {isAdjustment ? "Balance updated" : tx.description}
                                </span>
                                {isAdjustment && (
                                  <span className="text-[12px] text-muted-foreground whitespace-nowrap shrink-0">
                                    · {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d")}
                                  </span>
                                )}
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
                                  <StatusPill bg="var(--color-carolina-muted)" text="var(--color-primary)">
                                    <Check className="h-2.5 w-2.5" />
                                    {tx.transactionType === "income" ? "Confirmed" : "Paid"}
                                  </StatusPill>
                                )}
                                {isOverdue && (
                                  <StatusPill bg="#FFF3E0" text="#9A3412">
                                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#F97316" }} />
                                    Overdue
                                  </StatusPill>
                                )}
                                {isMissed && (
                                  <StatusPill bg="#FFF3E0" text="#633806">
                                    <TriangleAlert className="h-2.5 w-2.5" />
                                    Missed
                                  </StatusPill>
                                )}
                                {tx.isVariable && !tx.isActual && !isAdjustment && !isMissed && (
                                  <StatusPill bg="#EEEDFE" text="#3C3489">~ estimated</StatusPill>
                                )}
                                {isLifeEvent && (
                                  <StatusPill bg="var(--color-carolina-muted)" text="var(--color-primary)">Life event</StatusPill>
                                )}
                                {isAdjustment && (
                                  <StatusPill bg="var(--color-carolina-muted)" text="var(--color-primary)">
                                    <RefreshCw className="h-2.5 w-2.5" />
                                    Balance update
                                  </StatusPill>
                                )}
                                {isManual && !isLifeEvent && (
                                  <StatusPill bg="#F1F1EF" text="#55544F">Manual</StatusPill>
                                )}
                              </div>

                              {/* Amount (Part E, single-click to edit) */}
                              <div
                                className="px-2 py-[11px] flex items-center justify-end"
                                onClick={(e) => { e.stopPropagation(); if (!isEditing) startEdit(tx, e); }}
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
                                      className={`font-mono tabular-nums text-[13px] font-medium whitespace-nowrap ${isMissed ? "line-through text-muted-foreground" : ""}`}
                                      style={isMissed ? undefined : {
                                        color: isAdjustment ? "var(--color-primary)" : tx.transactionType === "income" ? "var(--color-positive)" : "var(--color-negative)",
                                      }}
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
                                      <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                                        {variance > 0 ? "+" : "−"}<FormatCurrency amount={Math.abs(variance)} /> vs planned
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Category badge */}
                              <div className="px-2 py-[11px] flex items-center justify-end min-w-0">
                                <span
                                  className="text-[11px] font-medium truncate"
                                  style={{ backgroundColor: meta.bg, color: meta.text, padding: "2px 8px", borderRadius: "10px" }}
                                >
                                  {catLabel(tx.category)}
                                </span>
                              </div>

                              {/* Running balance */}
                              <div className="px-2 py-[11px] flex items-center justify-end gap-1.5">
                                <span
                                  className="font-mono tabular-nums text-sm font-semibold whitespace-nowrap"
                                  style={{ color: balanceColor(tx.runningBalance) }}
                                >
                                  {isNeg && "−"}
                                  <FormatCurrency amount={Math.abs(tx.runningBalance)} />
                                </span>
                                {isCurrentBalance && (
                                  <span
                                    title="Current balance"
                                    className="h-1.5 w-1.5 rounded-full shrink-0 bg-primary"
                                  />
                                )}
                              </div>

                              {/* Actions (Part K) */}
                              <div
                                className="px-3 py-[11px] flex items-center justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {!tx.isActual && !isMissed && !isAdjustment && tx.transactionType === "expense" && (
                                  <button
                                    title="Mark as paid"
                                    onClick={() => handleMarkPaid(tx)}
                                    className="rounded-md border border-[#D6DBE3] bg-white px-2 py-[3px] text-[11px] font-medium text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors whitespace-nowrap"
                                  >
                                    Mark paid
                                  </button>
                                )}
                                {!tx.isActual && !isMissed && !isAdjustment && tx.transactionType === "income" && (
                                  <button
                                    title="Confirm received"
                                    onClick={() => handleMarkPaid(tx)}
                                    className="inline-flex items-center gap-1 rounded-md border bg-white px-2 py-[3px] text-[11px] font-medium transition-colors whitespace-nowrap hover:bg-primary/10 border-primary text-primary"
                                  >
                                    Confirm <Check className="h-3 w-3" />
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
                                    className="text-muted-foreground/60 hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                            </Fragment>
                          );
                        })}

                        {/* Otis insight rows (Part I) */}
                        {monthInsights.map((ins) => (
                          <div
                            key={ins.key}
                            className="flex items-start gap-3 px-4 py-3"
                            style={{
                              background: "linear-gradient(90deg, #EDFAF4 0%, #FFFFFF 100%)",
                              borderTop: "1px solid #E1F5EE",
                              borderBottom: "1px solid #E1F5EE",
                            }}
                          >
                            <div
                              className="h-7 w-7 shrink-0 rounded-full flex items-center justify-center mt-0.5"
                              style={{ backgroundColor: "#0D2B45" }}
                            >
                              <PawPrint className="h-3.5 w-3.5 text-white" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-[13px] leading-[1.6]" style={{ color: "#444444" }}>
                                {ins.body}
                              </div>
                              <button
                                onClick={() => askOtis(ins.prompt)}
                                className="mt-1 text-xs font-medium underline underline-offset-2 whitespace-nowrap hover:opacity-80 transition-opacity"
                                style={{ color: "var(--color-carolina)" }}
                              >
                                Ask Otis about this →
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {/* Category legend (Part L) */}
                {visibleCategories.length > 0 && (
                  <div
                    className="flex items-center gap-x-4 gap-y-1.5 flex-wrap px-4 py-2 border-t"
                    style={{ backgroundColor: "#FAFBFC", borderColor: "#EEF1F5" }}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Categories
                    </span>
                    {visibleCategories.map((c) => (
                      <span key={c} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: catMeta(c).color }} />
                        {catLabel(c)}
                      </span>
                    ))}
                  </div>
                )}

                {/* Totals footer (Part M) */}
                <div
                  className="grid grid-cols-4 divide-x divide-[#DDE2E8] border-t"
                  style={{ backgroundColor: "#F8F9FB", borderColor: "#DDE2E8" }}
                >
                  <div className="px-4 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly income</div>
                    <div className="text-[15px] font-semibold font-mono tabular-nums" style={{ color: "#0F6E56" }}>
                      <FormatCurrency amount={periodTotals.monthlyIncome} />
                    </div>
                  </div>
                  <div className="px-4 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly bills</div>
                    <div className="text-[15px] font-semibold font-mono tabular-nums" style={{ color: "#A32D2D" }}>
                      <FormatCurrency amount={periodTotals.monthlyBills} />
                    </div>
                  </div>
                  <div className="px-4 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Net this period</div>
                    <div
                      className="text-[15px] font-semibold font-mono tabular-nums"
                      style={{ color: periodTotals.net >= 0 ? "#0F6E56" : "#A32D2D" }}
                    >
                      {periodTotals.net >= 0 ? "+" : "−"}<FormatCurrency amount={Math.abs(periodTotals.net)} />
                    </div>
                  </div>
                  <div className="px-4 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Current balance</div>
                    <div className="text-[15px] font-semibold font-mono tabular-nums" style={{ color: "#0D2B45" }}>
                      {currentBalanceValue < 0 && "−"}<FormatCurrency amount={Math.abs(currentBalanceValue)} />
                    </div>
                  </div>
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
            <div className="border border-border rounded-lg overflow-x-auto">
              <div className="grid grid-cols-[1fr_130px_130px_130px_148px] min-w-[640px] bg-muted/60 border-b border-border text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
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
                      className="grid grid-cols-[1fr_130px_130px_130px_148px] min-w-[640px] cursor-pointer hover:bg-muted/30 transition-colors"
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
                            className="grid grid-cols-[1fr_130px_130px_130px_148px] min-w-[640px] border-b border-border/30 last:border-0 hover:bg-muted/20 cursor-pointer"
                            onClick={() => openTx(tx)}
                          >
                            <div className="px-4 py-2 pl-10 flex items-center gap-3 min-w-0">
                              <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                                {format(new Date(tx.transactionDate + "T00:00:00"), "MMM d")}
                              </span>
                              <span className="text-xs text-foreground truncate">{tx.description}</span>
                              <span
                                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                                style={{ backgroundColor: catMeta(tx.category).bg, color: catMeta(tx.category).text }}
                              >
                                {catLabel(tx.category)}
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
                    <RefreshCw className="h-4 w-4 mt-0.5 text-sky-600 shrink-0" />
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
