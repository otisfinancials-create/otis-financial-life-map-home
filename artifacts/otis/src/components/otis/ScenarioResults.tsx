import { useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormatCurrency } from "@/components/ui/format-currency";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronDown, MessageCircle, Save } from "lucide-react";
import { scenarioMeta, fmtMoney, fmtSigned, type ScenarioResultData } from "./scenario-meta";
import { computeScenarioAmortization, scenarioAmortInputs } from "./scenario-amortization";

interface ScenarioResultsProps {
  type: string;
  result: ScenarioResultData;
  inputs: Record<string, unknown>;
  saving: boolean;
  onSave: (name: string) => void;
  onAskOtis: () => void;
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function compactMoney(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function ScenarioResults({ type, result, inputs, saving, onSave, onAskOtis }: ScenarioResultsProps) {
  const meta = scenarioMeta(type);
  const [name, setName] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);

  const amortInputs = scenarioAmortInputs(type, inputs);
  const amortization = amortInputs
    ? computeScenarioAmortization(amortInputs.principal, amortInputs.annualRatePct, amortInputs.termMonths, amortInputs.startDate)
    : null;

  const sellCurrentHome = type === "buy_home" && inputs["sellCurrentHome"] === true;
  const salePrice = typeof inputs["salePrice"] === "number" ? (inputs["salePrice"] as number) : 0;
  const purchasePrice = typeof inputs["purchasePrice"] === "number" ? (inputs["purchasePrice"] as number) : 0;
  const netNewHousingCost = purchasePrice - salePrice;

  const endDiff =
    result.points.length > 0
      ? result.points[result.points.length - 1].scenario - result.points[result.points.length - 1].baseline
      : 0;
  const scenarioColor = endDiff >= 0 ? "#059669" : "#ea580c";

  const impactCards = [
    {
      label: "Monthly Cash Flow Impact",
      value: `${fmtSigned(result.monthlyCashFlowImpact)} per month`,
      positive: result.monthlyCashFlowImpact >= 0,
    },
    {
      label: "Net Worth Impact at 1 Year",
      value: fmtSigned(result.netWorthImpactOneYear),
      positive: result.netWorthImpactOneYear >= 0,
    },
    {
      label: "Retirement Impact",
      value: result.retirementImpactLabel,
      positive: !/less|later/i.test(result.retirementImpactLabel),
    },
  ];

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid gap-4 sm:grid-cols-3">
        {impactCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="pt-5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.label}</div>
              <div className={`mt-1.5 text-lg font-semibold leading-snug ${c.positive ? "text-emerald-700" : "text-orange-700"}`}>
                {c.value}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-5">
          <div className="text-sm font-semibold mb-3">Net worth — next 5 years, before vs after</div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={result.points} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={compactMoney} width={64} />
                <Tooltip
                  formatter={(value: number, key: string) => [
                    compactMoney(value),
                    key === "baseline" ? "Current trajectory" : "With this scenario",
                  ]}
                />
                <Legend
                  formatter={(value) => (value === "baseline" ? "Current trajectory" : "With this scenario")}
                />
                <Line type="monotone" dataKey="baseline" stroke="#9ca3af" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="scenario" stroke={scenarioColor} strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[#56A0D3]/30 bg-[#56A0D3]/5">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <div className="text-xl leading-none mt-0.5">🐾</div>
            <div>
              <div className="text-sm font-semibold text-[#0D2B45] mb-1">Otis says</div>
              <p className="text-sm leading-relaxed text-foreground">{result.commentary}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {sellCurrentHome && salePrice > 0 && (
        <Card className="border-emerald-600/30 bg-emerald-600/5">
          <CardContent className="pt-5 text-sm text-foreground">
            After selling your current home for <span className="font-semibold">{fmtMoney(salePrice)}</span>, your net new
            housing cost is <span className="font-semibold">{fmtMoney(netNewHousingCost)}</span>.
          </CardContent>
        </Card>
      )}

      {amortization && amortization.schedule.length > 0 && (
        <Card>
          <CardContent className="pt-5">
            <button
              type="button"
              onClick={() => setShowSchedule((v) => !v)}
              className="flex w-full items-center justify-between text-sm font-semibold"
            >
              <span>View Amortization Schedule</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${showSchedule ? "rotate-180" : ""}`} />
            </button>
            {showSchedule && (
              <div className="mt-4">
                <div className="mb-3 text-xs text-muted-foreground">
                  Estimated monthly payment: <span className="font-semibold text-foreground">{fmtMoney(amortization.monthlyPayment)}</span>
                  {" · "}Total interest: <span className="font-semibold text-foreground">{fmtMoney(amortization.totalInterest)}</span>
                </div>
                <div className="max-h-[440px] overflow-auto rounded-lg border border-border bg-card">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-muted">
                      <TableRow>
                        <TableHead>Payment #</TableHead>
                        <TableHead>Payment Date</TableHead>
                        <TableHead className="text-right">Payment Amount</TableHead>
                        <TableHead className="text-right">Principal</TableHead>
                        <TableHead className="text-right">Interest</TableHead>
                        <TableHead className="text-right">Remaining Balance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {amortization.schedule.map((entry) => (
                        <TableRow key={entry.paymentNumber}>
                          <TableCell className="text-muted-foreground">{entry.paymentNumber}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{formatDate(entry.paymentDate)}</TableCell>
                          <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.paymentAmount} /></TableCell>
                          <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.principal} /></TableCell>
                          <TableCell className="text-right font-mono text-xs text-red-600"><FormatCurrency amount={entry.interest} /></TableCell>
                          <TableCell className="text-right font-mono text-xs"><FormatCurrency amount={entry.remainingBalance} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`e.g. My ${meta.name.toLowerCase()} plan`}
            className="w-56 bg-white"
          />
          <Button
            variant="outline"
            disabled={saving || !name.trim()}
            onClick={() => onSave(name.trim())}
          >
            <Save className="h-4 w-4 mr-1.5" />
            {saving ? "Saving…" : "Save Scenario"}
          </Button>
        </div>
        <Button className="bg-[#56A0D3] hover:bg-[#56A0D3]/90 text-white" onClick={onAskOtis}>
          <MessageCircle className="h-4 w-4 mr-1.5" />
          Ask Otis about this
        </Button>
      </div>
    </div>
  );
}
