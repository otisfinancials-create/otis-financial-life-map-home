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
import { MessageCircle, Save } from "lucide-react";
import { scenarioMeta, fmtSigned, type ScenarioResultData } from "./scenario-meta";

interface ScenarioResultsProps {
  type: string;
  result: ScenarioResultData;
  saving: boolean;
  onSave: (name: string) => void;
  onAskOtis: () => void;
}

function compactMoney(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function ScenarioResults({ type, result, saving, onSave, onAskOtis }: ScenarioResultsProps) {
  const meta = scenarioMeta(type);
  const [name, setName] = useState("");

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

      <Card className="border-teal-600/30 bg-teal-600/5">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <div className="text-xl leading-none mt-0.5">🐾</div>
            <div>
              <div className="text-sm font-semibold text-teal-800 mb-1">Otis says</div>
              <p className="text-sm leading-relaxed text-foreground">{result.commentary}</p>
            </div>
          </div>
        </CardContent>
      </Card>

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
        <Button className="bg-teal-600 hover:bg-teal-700 text-white" onClick={onAskOtis}>
          <MessageCircle className="h-4 w-4 mr-1.5" />
          Ask Otis about this
        </Button>
      </div>
    </div>
  );
}
