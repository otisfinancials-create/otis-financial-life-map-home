import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, CreditCard } from "lucide-react";

import { useListCardCompositions } from "@workspace/api-client-react";
import type { CardComposition, Envelope } from "@workspace/api-client-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FormatCurrency } from "@/components/ui/format-currency";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Display-shape envelope after folding carryover: a carryover envelope is
 * last cycle's unspent food budget relocating forward — it is NOT new money,
 * so it never appears as its own line item. Its planned/spent are added to
 * the food envelope it rolls into (name/category kept from the target).
 */
export type DisplayEnvelope = {
  key: string;
  name: string;
  category: string | null;
  plannedAmount: number;
  spentAmount: number;
  includesCarryover: boolean;
};

export function foldCarryover(envelopes: Envelope[]): DisplayEnvelope[] {
  const carryovers = envelopes.filter((e) => e.isCarryover);
  const rest = envelopes.filter((e) => !e.isCarryover);
  const carryPlanned = carryovers.reduce((s, e) => s + e.plannedAmount, 0);
  const carrySpent = carryovers.reduce((s, e) => s + e.spentAmount, 0);

  const out: DisplayEnvelope[] = rest.map((e) => ({
    key: `env-${e.id}`,
    name: e.name,
    category: e.category ?? null,
    plannedAmount: e.plannedAmount,
    spentAmount: e.spentAmount,
    includesCarryover: false,
  }));

  if (carryovers.length > 0 && out.length > 0) {
    // Fold into the food envelope (that's what carryover rolls into). If the
    // cycle has no food envelope, fold into the catchall, else the first
    // envelope — carryover is NEVER its own line item.
    const foodIdx = rest.findIndex((r) => r.envelopeType === "food");
    const catchallIdx = rest.findIndex((r) => r.isCatchall);
    const target = out[foodIdx >= 0 ? foodIdx : catchallIdx >= 0 ? catchallIdx : 0];
    target.plannedAmount += carryPlanned;
    target.spentAmount += carrySpent;
    target.includesCarryover = true;
  }
  return out;
}

/** First (soonest-due) cycle per card from an already due-date-sorted list. */
export function nearestCyclePerCard(comps: CardComposition[]): CardComposition[] {
  const seen = new Set<number>();
  const out: CardComposition[] = [];
  for (const c of [...comps].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    if (seen.has(c.accountId)) continue;
    seen.add(c.accountId);
    out.push(c);
  }
  return out.sort((a, b) => a.accountName.localeCompare(b.accountName));
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Bills-page section: mirrors the forecast's card-payment parent/child
 * treatment — one parent row per card (current cycle), expandable into the
 * bills allocated to that cycle AND its envelopes. Presentation only.
 */
export function CardCompositionSection() {
  const { data: comps } = useListCardCompositions({ dueStart: todayIso() });
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const cards = nearestCyclePerCard(comps ?? []);
  if (cards.length === 0) return null;

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card className="border-card-border bg-card rounded-xl overflow-hidden" data-testid="card-composition-section">
      <div className="px-5 pt-4 pb-1">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-muted-foreground" />
          What your cards cover
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Each card's next payment is made of the bills allocated to its cycle plus its spending envelopes.
          These dollars already flow through the card payment in your forecast — nothing here is counted twice.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead>Card / Item</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Planned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cards.map((c) => {
            const open = !collapsed.has(c.cycleId);
            const envs = foldCarryover(c.envelopes);
            return (
              <Fragment key={c.cycleId}>
                <TableRow
                  className="border-border cursor-pointer font-medium"
                  onClick={() => toggle(c.cycleId)}
                  data-testid={`row-card-composition-${c.accountId}`}
                >
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      💳 {c.accountName}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    cycle due {fmtDate(c.dueDate)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    <FormatCurrency amount={c.plannedTotal} />
                  </TableCell>
                </TableRow>
                {open && c.bills.map((b) => (
                  <TableRow key={`cb-${b.id}`} className="border-border bg-muted/20 hover:bg-muted/20">
                    <TableCell className="pl-12 text-sm text-muted-foreground">↳ {b.billName}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">bill</Badge></TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      <FormatCurrency amount={b.expectedAmount} />
                    </TableCell>
                  </TableRow>
                ))}
                {open && envs.map((e) => (
                  <TableRow key={e.key} className="border-border bg-muted/20 hover:bg-muted/20">
                    <TableCell className="pl-12 text-sm text-muted-foreground">
                      ↳ {e.name}
                      {e.includesCarryover && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground/70">(incl. carryover)</span>
                      )}
                    </TableCell>
                    <TableCell><Badge variant="secondary" className="text-[10px]">envelope</Badge></TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      <FormatCurrency amount={e.plannedAmount} />
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
