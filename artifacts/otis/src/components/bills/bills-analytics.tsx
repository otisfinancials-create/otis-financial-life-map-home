import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

import type { Bill } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { FormatCurrency } from "@/components/ui/format-currency";
import { categoryMeta } from "@/utils/categoryIcons";
import { monthlyFactor } from "@/lib/bill-math";

type Slice = {
  name: string;
  value: number;
  pct: number;
  color: string;
};

function SliceTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Slice }> }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md text-xs">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
        {s.name}
      </div>
      <div className="mt-1 font-mono text-foreground">
        <FormatCurrency amount={s.value} />
        <span className="text-muted-foreground"> / mo</span>
      </div>
      <div className="text-muted-foreground">{s.pct.toFixed(1)}% of total bills</div>
    </div>
  );
}

interface BillsAnalyticsProps {
  bills: Bill[];
  selectedCategory?: string | null;
  onSelectCategory?: (category: string | null) => void;
}

export function BillsAnalytics({ bills, selectedCategory = null, onSelectCategory }: BillsAnalyticsProps) {
  const { slices, totalMonthly } = useMemo(() => {
    const byCategory: Record<string, number> = {};
    for (const bill of bills) {
      if (!bill.isActive) continue;
      const monthly = bill.amount * monthlyFactor(bill.frequency);
      byCategory[bill.category] = (byCategory[bill.category] ?? 0) + monthly;
    }
    // Category % = (category monthly total ÷ sum of ALL category monthly totals) × 100.
    const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
    const result: Slice[] = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        name,
        value,
        pct: total > 0 ? (value / total) * 100 : 0,
        color: categoryMeta(name).color,
      }));
    // Largest-remainder rounding so the displayed 1-decimal percentages sum to exactly 100.0.
    if (total > 0 && result.length > 0) {
      const floored = result.map((s) => Math.floor(s.pct * 10));
      let leftover = 1000 - floored.reduce((s, v) => s + v, 0);
      const order = result
        .map((s, i) => ({ i, frac: s.pct * 10 - Math.floor(s.pct * 10) }))
        .sort((a, b) => b.frac - a.frac);
      for (const { i } of order) {
        if (leftover <= 0) break;
        floored[i] += 1;
        leftover -= 1;
      }
      result.forEach((s, i) => { s.pct = floored[i] / 10; });
    }
    return { slices: result, totalMonthly: total };
  }, [bills]);

  if (slices.length === 0) return null;

  const largest = slices[0];

  return (
    <Card className="border-card-border bg-card rounded-xl shadow-sm p-6 space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-card-border bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Monthly Bills</p>
          <p className="mt-1 text-xl font-bold font-mono text-foreground">
            <FormatCurrency amount={totalMonthly} />
          </p>
        </div>
        <div className="rounded-lg border border-card-border bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Total Annual Bills</p>
          <p className="mt-1 text-xl font-bold font-mono text-foreground">
            <FormatCurrency amount={totalMonthly * 12} />
          </p>
        </div>
        <div className="rounded-lg border border-card-border bg-background px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Largest Single Category</p>
          <p className="mt-1 text-xl font-bold text-foreground flex items-baseline gap-2 min-w-0">
            <span className="truncate">{largest.name}</span>
            <span className="font-mono text-sm text-muted-foreground shrink-0">
              <FormatCurrency amount={largest.value} />/mo
            </span>
          </p>
        </div>
      </div>

      {/* Donut + legend */}
      <div>
        <h3 className="text-sm font-semibold text-foreground">Bills by Category</h3>
        <p className="text-[11px] italic text-muted-foreground mt-0.5">
          Monthly equivalents — all bill amounts normalized to a monthly figure for comparison.
        </p>
      </div>
      <div className="flex flex-col lg:flex-row items-center gap-8">
        <div className="relative h-56 w-56 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius={70}
                outerRadius={100}
                paddingAngle={2}
                strokeWidth={0}
                onClick={(_, index) => {
                  const name = slices[index]?.name;
                  if (!name || !onSelectCategory) return;
                  onSelectCategory(selectedCategory === name ? null : name);
                }}
                cursor={onSelectCategory ? "pointer" : undefined}
              >
                {slices.map((s) => (
                  <Cell
                    key={s.name}
                    fill={s.color}
                    fillOpacity={selectedCategory && selectedCategory !== s.name ? 0.25 : 1}
                    stroke={selectedCategory === s.name ? "var(--foreground)" : "none"}
                    strokeWidth={selectedCategory === s.name ? 1.5 : 0}
                  />
                ))}
              </Pie>
              <Tooltip content={<SliceTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          {/* Center total */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {selectedCategory ?? "Monthly"}
            </span>
            <span className="text-lg font-bold font-mono text-foreground">
              <FormatCurrency
                amount={selectedCategory
                  ? (slices.find((s) => s.name === selectedCategory)?.value ?? 0)
                  : totalMonthly}
              />
            </span>
          </div>
        </div>

        {/* Legend */}
        <div className="w-full flex-1 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
            {(selectedCategory ? slices.filter((s) => s.name === selectedCategory) : slices).map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => onSelectCategory?.(selectedCategory === s.name ? null : s.name)}
                className={`flex items-center gap-2.5 text-sm text-left w-full rounded-sm px-1 -mx-1 transition-colors ${
                  selectedCategory === s.name ? "bg-muted/60" : "hover:bg-muted/40"
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                <span className="text-foreground font-medium truncate">{s.name}</span>
                <span className="ml-auto font-mono text-foreground whitespace-nowrap">
                  <FormatCurrency amount={s.value} />
                </span>
                <span className="w-12 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {s.pct.toFixed(1)}%
                </span>
              </button>
            ))}
          </div>
          {selectedCategory && (
            <button
              type="button"
              onClick={() => onSelectCategory?.(null)}
              className="text-xs text-primary hover:underline"
            >
              Clear filter — show all categories
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
