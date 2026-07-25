import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Utensils, Package, Lock } from "lucide-react";
import {
  useListAccountCycles,
  getListAccountCyclesQueryKey,
  useListCycleEnvelopes,
  getListCycleEnvelopesQueryKey,
  useCreateCycleEnvelope,
  useUpdateEnvelope,
  useDeleteEnvelope,
  type Account,
  type Envelope,
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

function formatCycleRange(startIso: string, endIso: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  return `${fmt(startIso)} – ${fmt(endIso)}`;
}

const EMPTY_FORM = { name: "", category: "", plannedAmount: "", cadence: "one-time", scope: "this-cycle" };

export function EnvelopesDialog({ account, open, onOpenChange }: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: cycles } = useListAccountCycles(account.id, {
    query: { queryKey: getListAccountCyclesQueryKey(account.id), enabled: open },
  });

  // Current cycle: the one containing today, else the next upcoming one.
  const currentCycle = useMemo(() => {
    if (!cycles?.length) return undefined;
    const today = new Date().toISOString().slice(0, 10);
    return cycles.find((c) => c.cycleStart <= today && today <= c.cycleEnd)
      ?? cycles.find((c) => c.cycleStart > today)
      ?? cycles[cycles.length - 1];
  }, [cycles]);

  const { data: envelopes } = useListCycleEnvelopes(currentCycle?.id ?? 0, {
    query: {
      queryKey: getListCycleEnvelopesQueryKey(currentCycle?.id ?? 0),
      enabled: open && currentCycle != null,
    },
  });

  const invalidate = () => {
    if (currentCycle) {
      void queryClient.invalidateQueries({ queryKey: getListCycleEnvelopesQueryKey(currentCycle.id) });
    }
    void queryClient.invalidateQueries({ queryKey: getListAccountCyclesQueryKey(account.id) });
  };

  const createEnvelope = useCreateCycleEnvelope({ mutation: { onSuccess: invalidate } });
  const updateEnvelope = useUpdateEnvelope({ mutation: { onSuccess: invalidate } });
  const deleteEnvelope = useDeleteEnvelope({
    mutation: {
      onSuccess: invalidate,
      onError: () => toast({ title: "The catch-all envelope can't be deleted", variant: "destructive" }),
    },
  });

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; plannedAmount: string; weeklyRate: string }>({ name: "", plannedAmount: "", weeklyRate: "" });

  const mondays = currentCycle ? mondaysInRange(currentCycle.cycleStart, currentCycle.cycleEnd) : 0;

  const startEdit = (e: Envelope) => {
    setEditingId(e.id);
    setEditValues({
      name: e.name,
      plannedAmount: String(e.plannedAmount),
      weeklyRate: e.weeklyRate != null ? String(e.weeklyRate) : "0",
    });
  };

  const saveEdit = (e: Envelope) => {
    const data: Record<string, unknown> = { name: editValues.name.trim() || e.name };
    if (e.envelopeType === "food") {
      data.weeklyRate = parseFloat(editValues.weeklyRate) || 0;
    } else {
      data.plannedAmount = parseFloat(editValues.plannedAmount) || 0;
    }
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Envelopes — {account.accountName}</DialogTitle>
          <DialogDescription>
            {currentCycle
              ? <>Current cycle {formatCycleRange(currentCycle.cycleStart, currentCycle.cycleEnd)} · due {formatCycleRange(currentCycle.dueDate, currentCycle.dueDate).split(" – ")[0]}</>
              : "No cycles yet — set the card's statement and due days first."}
          </DialogDescription>
        </DialogHeader>

        {currentCycle && (
          <div className="space-y-2">
            {(envelopes ?? []).map((e) => (
              <div key={e.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {e.envelopeType === "food" ? <Utensils className="h-4 w-4 text-primary shrink-0" /> : <Package className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <span className="text-sm font-medium truncate">{e.name}</span>
                    {e.isCatchall && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        <Lock className="mr-1 h-2.5 w-2.5" />
                        Catch-all
                      </Badge>
                    )}
                    {e.recurring && <Badge variant="outline" className="text-[10px] px-1.5 py-0">Recurring</Badge>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-sm font-mono mr-1"><FormatCurrency amount={e.plannedAmount} /></span>
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
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" onClick={() => saveEdit(e)} disabled={updateEnvelope.isPending}>Save</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

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
        )}
      </DialogContent>
    </Dialog>
  );
}
