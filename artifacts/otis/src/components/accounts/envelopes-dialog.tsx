import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Utensils, Package, Lock, ChevronLeft, ChevronRight, Archive, Receipt } from "lucide-react";
import {
  useListAccountCycles,
  getListAccountCyclesQueryKey,
  useListCycleEnvelopes,
  getListCycleEnvelopesQueryKey,
  useGetCycleBreakdown,
  getGetCycleBreakdownQueryKey,
  useListCycleCharges,
  getListCycleChargesQueryKey,
  useCreateCycleEnvelope,
  useUpdateEnvelope,
  useDeleteEnvelope,
  useCreateCycleCharge,
  useUpdateCycleCharge,
  useDeleteCycleCharge,
  getListForecastQueryKey,
  getGetMonthlyForecastQueryKey,
  type Account,
  type Envelope,
  type ManualCharge,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { FormatCurrency } from "@/components/ui/format-currency";
import { useToast } from "@/hooks/use-toast";

/** Count Mondays between two YYYY-MM-DD dates, inclusive (mirrors server logic). */
function mondaysInRange(startIso: string, endIso: string): number {
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  if (end < start) return 0;
  const first = new Date(start);
  first.setDate(first.getDate() + ((8 - first.getDay()) % 7));
  if (first > end) return 0;
  return Math.floor((end.getTime() - first.getTime()) / (7 * 86400000)) + 1;
}

const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

function formatCycleRange(startIso: string, endIso: string): string {
  return `${fmtDay(startIso)} – ${fmtDay(endIso)}`;
}

// Client failures throw ApiError with the server payload on `.data`
// (e.g. { error: "..." }) and a readable `.message` fallback.
function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { error?: string } | null })?.data;
  if (data?.error) return data.error;
  const message = (err as { message?: string })?.message;
  return message || fallback;
}

const EMPTY_FORM = { name: "", category: "", plannedAmount: "", cadence: "one-time", scope: "this-cycle" };
const EMPTY_CHARGE = { amount: "", txnDate: "", description: "", target: "" };

export function EnvelopesDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isManualCard = account.plaidAccountId == null;

  const { data: cycles } = useListAccountCycles(account.id, {
    query: { queryKey: getListAccountCyclesQueryKey(account.id), enabled: open },
  });

  const sortedCycles = useMemo(
    () => (cycles ? [...cycles].sort((a, b) => a.cycleStart.localeCompare(b.cycleStart)) : []),
    [cycles],
  );

  // Selected cycle: default to the one containing today, else next upcoming.
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  useEffect(() => {
    if (!open) { setSelectedCycleId(null); return; }
    if (selectedCycleId != null || !sortedCycles.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const current = sortedCycles.find((c) => c.cycleStart <= today && today <= c.cycleEnd)
      ?? sortedCycles.find((c) => c.cycleStart > today)
      ?? sortedCycles[sortedCycles.length - 1];
    setSelectedCycleId(current.id);
  }, [open, sortedCycles, selectedCycleId]);

  const cycleIndex = sortedCycles.findIndex((c) => c.id === selectedCycleId);
  const currentCycle = cycleIndex >= 0 ? sortedCycles[cycleIndex] : undefined;

  const { data: envelopes } = useListCycleEnvelopes(currentCycle?.id ?? 0, {
    query: {
      queryKey: getListCycleEnvelopesQueryKey(currentCycle?.id ?? 0),
      enabled: open && currentCycle != null,
    },
  });
  const { data: breakdown } = useGetCycleBreakdown(currentCycle?.id ?? 0, {
    query: {
      queryKey: getGetCycleBreakdownQueryKey(currentCycle?.id ?? 0),
      enabled: open && currentCycle != null,
    },
  });
  const { data: charges } = useListCycleCharges(currentCycle?.id ?? 0, {
    query: {
      queryKey: getListCycleChargesQueryKey(currentCycle?.id ?? 0),
      enabled: open && currentCycle != null && isManualCard,
    },
  });

  const invalidate = () => {
    if (currentCycle) {
      void queryClient.invalidateQueries({ queryKey: getListCycleEnvelopesQueryKey(currentCycle.id) });
      void queryClient.invalidateQueries({ queryKey: getGetCycleBreakdownQueryKey(currentCycle.id) });
      void queryClient.invalidateQueries({ queryKey: getListCycleChargesQueryKey(currentCycle.id) });
    }
    void queryClient.invalidateQueries({ queryKey: getListAccountCyclesQueryKey(account.id) });
    // Envelope/charge changes move the projected payment in the forecast.
    void queryClient.invalidateQueries({ queryKey: getListForecastQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetMonthlyForecastQueryKey() });
  };

  const createEnvelope = useCreateCycleEnvelope({ mutation: { onSuccess: invalidate } });
  const updateEnvelope = useUpdateEnvelope({ mutation: { onSuccess: invalidate } });
  const deleteEnvelope = useDeleteEnvelope({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) => toast({ title: apiErrorMessage(err, "This envelope can't be deleted"), variant: "destructive" }),
    },
  });
  const createCharge = useCreateCycleCharge({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) => toast({ title: apiErrorMessage(err, "Failed to add charge"), variant: "destructive" }),
    },
  });
  const updateCharge = useUpdateCycleCharge({
    mutation: {
      onSuccess: invalidate,
      onError: (err: unknown) => toast({ title: apiErrorMessage(err, "Failed to update charge"), variant: "destructive" }),
    },
  });
  const deleteCharge = useDeleteCycleCharge({ mutation: { onSuccess: invalidate } });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; plannedAmount: string; weeklyRate: string; scope: string }>({ name: "", plannedAmount: "", weeklyRate: "", scope: "all-future" });

  // Manual charge entry state.
  const [addingCharge, setAddingCharge] = useState(false);
  const [chargeForm, setChargeForm] = useState(EMPTY_CHARGE);
  const [editingChargeId, setEditingChargeId] = useState<number | null>(null);

  const mondays = currentCycle ? mondaysInRange(currentCycle.cycleStart, currentCycle.cycleEnd) : 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const isClosed = currentCycle ? (currentCycle.status === "closed" || todayStr > currentCycle.cycleEnd) : false;
  const paymentAmount = currentCycle
    ? (isClosed ? currentCycle.accumulatedTotal : Math.max(currentCycle.accumulatedTotal, currentCycle.plannedTotal))
    : 0;

  const startEdit = (e: Envelope) => {
    setEditingId(e.id);
    setEditValues({
      name: e.name,
      plannedAmount: String(e.plannedAmount),
      weeklyRate: e.weeklyRate != null ? String(e.weeklyRate) : "0",
      scope: "all-future",
    });
  };

  const saveEdit = (e: Envelope) => {
    const data: Record<string, unknown> = { name: editValues.name.trim() || e.name };
    if (e.envelopeType === "food") {
      data.weeklyRate = parseFloat(editValues.weeklyRate) || 0;
    } else {
      data.plannedAmount = parseFloat(editValues.plannedAmount) || 0;
    }
    if (e.recurring && !e.isCarryover) data.scope = editValues.scope;
    updateEnvelope.mutate({ id: e.id, data }, { onSuccess: () => setEditingId(null) });
  };

  const submitAdd = () => {
    if (!currentCycle || !form.name.trim()) return;
    createEnvelope.mutate(
      {
        cycleId: currentCycle.id,
        data: {
          name: form.name.trim(),
          category: form.category.trim() || null,
          plannedAmount: parseFloat(form.plannedAmount) || 0,
          cadence: form.cadence as "weekly" | "one-time",
          scope: form.scope as "this-cycle" | "all-future",
        },
      },
      { onSuccess: () => { setAdding(false); setForm(EMPTY_FORM); } },
    );
  };

  const chargeTargets = useMemo(() => [
    ...(envelopes ?? []).map((e) => ({ value: `env-${e.id}`, label: `Envelope · ${e.name}` })),
    ...(breakdown?.bills ?? []).map((b) => ({ value: `bill-${b.id}`, label: `Bill · ${b.billName}` })),
  ], [envelopes, breakdown]);

  const chargeTargetIds = (target: string) => {
    const [kind, idStr] = target.split("-");
    const id = Number(idStr);
    return kind === "env" ? { envelopeId: id, cardCycleBillId: null } : { envelopeId: null, cardCycleBillId: id };
  };

  const submitCharge = () => {
    if (!currentCycle || !chargeForm.amount || !chargeForm.txnDate || !chargeForm.target) return;
    const data = {
      amount: parseFloat(chargeForm.amount) || 0,
      txnDate: chargeForm.txnDate,
      description: chargeForm.description.trim() || null,
      ...chargeTargetIds(chargeForm.target),
    };
    if (editingChargeId != null) {
      updateCharge.mutate({ id: editingChargeId, data }, {
        onSuccess: () => { setAddingCharge(false); setChargeForm(EMPTY_CHARGE); setEditingChargeId(null); },
      });
    } else {
      createCharge.mutate({ cycleId: currentCycle.id, data }, {
        onSuccess: () => { setAddingCharge(false); setChargeForm(EMPTY_CHARGE); },
      });
    }
  };

  const startEditCharge = (c: ManualCharge) => {
    setEditingChargeId(c.id);
    setChargeForm({
      amount: String(c.amount),
      txnDate: c.txnDate ?? "",
      description: c.description ?? "",
      target: c.envelopeId != null ? `env-${c.envelopeId}` : `bill-${c.cardCycleBillId}`,
    });
    setAddingCharge(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Card cycle — {account.accountName}</DialogTitle>
          <DialogDescription>
            {currentCycle
              ? "Envelopes and bills that make up this cycle's payment."
              : "No cycles yet — set the card's statement and due days first."}
          </DialogDescription>
        </DialogHeader>

        {currentCycle && (
          <div className="space-y-4">
            {/* ── Cycle header (the parent) ─────────────────────────── */}
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    disabled={cycleIndex <= 0}
                    onClick={() => setSelectedCycleId(sortedCycles[cycleIndex - 1].id)}
                    aria-label="Previous cycle"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {formatCycleRange(currentCycle.cycleStart, currentCycle.cycleEnd)}
                  </div>
                  <Button
                    variant="ghost" size="icon" className="h-7 w-7"
                    disabled={cycleIndex < 0 || cycleIndex >= sortedCycles.length - 1}
                    onClick={() => setSelectedCycleId(sortedCycles[cycleIndex + 1].id)}
                    aria-label="Next cycle"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  {isClosed
                    ? <Badge variant="secondary" className="text-[10px]">Closed</Badge>
                    : <Badge variant="outline" className="text-[10px]">Open</Badge>}
                </div>
                <div className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-lg font-bold font-mono tabular-nums">
                      <FormatCurrency amount={paymentAmount} />
                    </span>
                    <span
                      className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none whitespace-nowrap"
                      style={isClosed
                        ? { backgroundColor: "#E7F6EC", color: "#059669" }
                        : { backgroundColor: "#FFF4E5", color: "#B45309" }}
                    >
                      {isClosed ? "Actual" : "Projected"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">payment due {fmtDay(currentCycle.dueDate)}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm border-t border-border pt-3">
                <div>
                  <div className="text-xs text-muted-foreground">Accumulated so far</div>
                  <div className="font-mono tabular-nums font-semibold"><FormatCurrency amount={currentCycle.accumulatedTotal} /></div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Planned total</div>
                  <div className="font-mono tabular-nums font-semibold"><FormatCurrency amount={currentCycle.plannedTotal} /></div>
                </div>
              </div>
            </div>

            {/* ── Envelopes (children) ─────────────────────────────── */}
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Envelopes</div>
              {(envelopes ?? []).map((e) => {
                const remaining = Math.max(0, e.plannedAmount - e.spentAmount);
                const overspent = e.spentAmount > e.plannedAmount + 0.005;
                return (
                  <div key={e.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {e.envelopeType === "food"
                          ? <Utensils className="h-4 w-4 text-primary shrink-0" />
                          : e.isCarryover
                            ? <Archive className="h-4 w-4 text-amber-600 shrink-0" />
                            : <Package className="h-4 w-4 text-muted-foreground shrink-0" />}
                        <span className="text-sm font-medium truncate">{e.name}</span>
                        {e.isCarryover && (
                          <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-800 hover:bg-amber-100">Carryover</Badge>
                        )}
                        {e.isCatchall && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            <Lock className="mr-1 h-2.5 w-2.5" />
                            Catch-all
                          </Badge>
                        )}
                        {e.recurring && <Badge variant="outline" className="text-[10px] px-1.5 py-0">Recurring</Badge>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => (editingId === e.id ? setEditingId(null) : startEdit(e))}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!e.isCatchall && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            onClick={() => deleteEnvelope.mutate({ id: e.id })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <div className="text-[11px] text-muted-foreground">Planned</div>
                        <div className="font-mono tabular-nums"><FormatCurrency amount={e.plannedAmount} /></div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground">Spent</div>
                        <div className="font-mono tabular-nums"><FormatCurrency amount={e.spentAmount} /></div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground">Remaining</div>
                        <div className={`font-mono tabular-nums ${overspent ? "text-destructive font-semibold" : ""}`}>
                          <FormatCurrency amount={remaining} />
                        </div>
                      </div>
                    </div>
                    {overspent && (
                      <p className="mt-1 text-xs font-medium text-destructive">
                        Overspent by <FormatCurrency amount={e.spentAmount - e.plannedAmount} />
                      </p>
                    )}
                    {e.note && (
                      <p className="mt-1 text-xs text-muted-foreground italic">{e.note}</p>
                    )}

                    {editingId === e.id && (
                      <div className="mt-3 space-y-2 border-t border-border pt-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Name</Label>
                            <Input value={editValues.name} onChange={(ev) => setEditValues((v) => ({ ...v, name: ev.target.value }))} className="h-8" />
                          </div>
                          {e.envelopeType === "food" ? (
                            <div>
                              <Label className="text-xs">Weekly rate</Label>
                              <Input
                                type="number"
                                value={editValues.weeklyRate}
                                onChange={(ev) => setEditValues((v) => ({ ...v, weeklyRate: ev.target.value }))}
                                className="h-8"
                              />
                            </div>
                          ) : (
                            <div>
                              <Label className="text-xs">Planned amount</Label>
                              <Input
                                type="number"
                                value={editValues.plannedAmount}
                                onChange={(ev) => setEditValues((v) => ({ ...v, plannedAmount: ev.target.value }))}
                                className="h-8"
                              />
                            </div>
                          )}
                        </div>
                        {e.envelopeType === "food" && (
                          <p className="text-xs text-muted-foreground">
                            {mondays} weeks in this cycle × <FormatCurrency amount={parseFloat(editValues.weeklyRate) || 0} /> ={" "}
                            <span className="font-medium"><FormatCurrency amount={mondays * (parseFloat(editValues.weeklyRate) || 0)} /></span> for the cycle
                          </p>
                        )}
                        {e.recurring && !e.isCarryover && (
                          <RadioGroup
                            value={editValues.scope}
                            onValueChange={(v) => setEditValues((vals) => ({ ...vals, scope: v }))}
                            className="flex gap-4"
                          >
                            <div className="flex items-center gap-1.5">
                              <RadioGroupItem value="all-future" id={`scope-future-${e.id}`} data-testid={`radio-scope-future-${e.id}`} />
                              <Label htmlFor={`scope-future-${e.id}`} className="text-xs font-normal">This & future cycles</Label>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <RadioGroupItem value="this-cycle" id={`scope-cycle-${e.id}`} data-testid={`radio-scope-cycle-${e.id}`} />
                              <Label htmlFor={`scope-cycle-${e.id}`} className="text-xs font-normal">This cycle only</Label>
                            </div>
                          </RadioGroup>
                        )}
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                          <Button size="sm" onClick={() => saveEdit(e)} disabled={updateEnvelope.isPending}>Save</Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {adding ? (
                <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Name</Label>
                      <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="h-8" placeholder="e.g. Streaming" />
                    </div>
                    <div>
                      <Label className="text-xs">Category</Label>
                      <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="h-8" placeholder="Optional" />
                    </div>
                    <div>
                      <Label className="text-xs">Planned amount</Label>
                      <Input type="number" value={form.plannedAmount} onChange={(e) => setForm((f) => ({ ...f, plannedAmount: e.target.value }))} className="h-8" placeholder="0" />
                    </div>
                    <div>
                      <Label className="text-xs">Cadence</Label>
                      <Select value={form.cadence} onValueChange={(v) => setForm((f) => ({ ...f, cadence: v }))}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="one-time">One-time</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <RadioGroup value={form.scope} onValueChange={(v) => setForm((f) => ({ ...f, scope: v }))} className="flex gap-4 pt-1">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <RadioGroupItem value="this-cycle" /> Just this cycle
                    </label>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <RadioGroupItem value="all-future" /> This and all future cycles
                    </label>
                  </RadioGroup>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setForm(EMPTY_FORM); }}>Cancel</Button>
                    <Button size="sm" onClick={submitAdd} disabled={!form.name.trim() || createEnvelope.isPending}>Add envelope</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="w-full" onClick={() => setAdding(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add envelope
                </Button>
              )}
            </div>

            {/* ── Bills (children) ──────────────────────────────────── */}
            {(breakdown?.bills.length ?? 0) > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Bills on this card</div>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {breakdown!.bills.map((b) => (
                    <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Receipt className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{b.billName}</span>
                        <Badge
                          variant={b.status === "hit" ? "default" : b.status === "missed" ? "destructive" : "secondary"}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {b.status === "hit" ? "Paid" : b.status === "missed" ? "Missed" : "Pending"}
                        </Badge>
                      </div>
                      <span className="text-sm font-mono tabular-nums whitespace-nowrap">
                        {b.actualAmount != null
                          ? <><FormatCurrency amount={b.actualAmount} /> <span className="text-xs text-muted-foreground">/ expected <FormatCurrency amount={b.expectedAmount} /></span></>
                          : <span className="text-muted-foreground">expected <FormatCurrency amount={b.expectedAmount} /></span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Manual charges (manual cards only) ────────────────── */}
            {isManualCard && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Charges (entered by hand)
                </div>
                {(charges ?? []).length > 0 && (
                  <div className="rounded-lg border border-border divide-y divide-border">
                    {charges!.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{c.description || c.targetName}</div>
                          <div className="text-xs text-muted-foreground">
                            {c.txnDate ? fmtDay(c.txnDate) : ""} · {c.targetName}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-sm font-mono tabular-nums mr-1"><FormatCurrency amount={c.amount} /></span>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEditCharge(c)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                            onClick={() => deleteCharge.mutate({ id: c.id })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {addingCharge ? (
                  <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Amount</Label>
                        <Input type="number" value={chargeForm.amount} onChange={(e) => setChargeForm((f) => ({ ...f, amount: e.target.value }))} className="h-8" placeholder="0.00" />
                      </div>
                      <div>
                        <Label className="text-xs">Date</Label>
                        <Input
                          type="date"
                          min={currentCycle.cycleStart}
                          max={currentCycle.cycleEnd}
                          value={chargeForm.txnDate}
                          onChange={(e) => setChargeForm((f) => ({ ...f, txnDate: e.target.value }))}
                          className="h-8"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Description</Label>
                        <Input value={chargeForm.description} onChange={(e) => setChargeForm((f) => ({ ...f, description: e.target.value }))} className="h-8" placeholder="e.g. Kroger" />
                      </div>
                      <div>
                        <Label className="text-xs">Applies to</Label>
                        <Select value={chargeForm.target} onValueChange={(v) => setChargeForm((f) => ({ ...f, target: v }))}>
                          <SelectTrigger className="h-8"><SelectValue placeholder="Envelope or bill" /></SelectTrigger>
                          <SelectContent>
                            {chargeTargets.map((t) => (
                              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setAddingCharge(false); setChargeForm(EMPTY_CHARGE); setEditingChargeId(null); }}>Cancel</Button>
                      <Button
                        size="sm"
                        onClick={submitCharge}
                        disabled={!chargeForm.amount || !chargeForm.txnDate || !chargeForm.target || createCharge.isPending || updateCharge.isPending}
                      >
                        {editingChargeId != null ? "Save charge" : "Add charge"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setAddingCharge(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add charge
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
