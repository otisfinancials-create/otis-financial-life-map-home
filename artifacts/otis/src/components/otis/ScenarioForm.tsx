import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useListLoans, useGetDashboardSummary, useGetRetirementSettings, useListAssets } from "@workspace/api-client-react";
import { scenarioMeta, fmtMoney } from "./scenario-meta";

type Inputs = Record<string, unknown>;

interface ScenarioFormProps {
  type: string;
  initialInputs?: Inputs;
  running: boolean;
  onRun: (inputs: Inputs) => void;
  onCustomSubmit: (text: string) => void;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-1.5">{children}</div>;
}

function simulatePayoff(balance: number, ratePct: number, payment: number, extra: number) {
  const r = ratePct / 100 / 12;
  let bal = balance;
  let months = 0;
  let interest = 0;
  const monthly = payment + extra;
  while (bal > 0 && months < 600) {
    const i = bal * r;
    interest += i;
    bal = bal + i - monthly;
    months++;
    if (monthly <= i) break;
  }
  return { months, interest };
}

export function ScenarioForm({ type, initialInputs, running, onRun, onCustomSubmit }: ScenarioFormProps) {
  const meta = scenarioMeta(type);
  const [f, setF] = useState<Inputs>(initialInputs ?? {});
  const [customText, setCustomText] = useState("");

  const { data: summary } = useGetDashboardSummary();
  const { data: loans } = useListLoans();
  const { data: retirement } = useGetRetirementSettings();
  const { data: assets } = useListAssets();

  const realEstateAsset = (assets ?? []).find((a) => a.assetType === "real_estate");

  const set = (k: string, v: unknown) => setF((prev) => ({ ...prev, [k]: v }));
  const num = (k: string, fallback = 0): number => {
    const v = f[k];
    const parsed = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return isNaN(parsed) ? fallback : parsed;
  };
  const str = (k: string, fallback = ""): string => (typeof f[k] === "string" ? (f[k] as string) : fallback);
  const bool = (k: string): boolean => f[k] === true;

  const numberField = (key: string, label: string, placeholder?: string) => (
    <Row>
      <Label htmlFor={`sf-${key}`}>{label}</Label>
      <Input
        id={`sf-${key}`}
        type="number"
        value={f[key] == null ? "" : String(f[key])}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value === "" ? undefined : parseFloat(e.target.value))}
      />
    </Row>
  );

  const dateField = (key: string, label: string) => (
    <Row>
      <Label htmlFor={`sf-${key}`}>{label}</Label>
      <Input
        id={`sf-${key}`}
        type="date"
        value={str(key)}
        onChange={(e) => set(key, e.target.value)}
      />
    </Row>
  );

  const income = summary?.monthlyIncome ?? 0;

  const debtPreview = useMemo(() => {
    if (type !== "extra_debt_payment" || !loans?.length) return null;
    const loanId = num("loanId", loans[0].id);
    const loan = loans.find((l) => l.id === loanId) ?? loans[0];
    const extra = num("extraMonthly", 100);
    const base = simulatePayoff(loan.currentBalance, loan.interestRate, loan.monthlyPayment, 0);
    const accel = simulatePayoff(loan.currentBalance, loan.interestRate, loan.monthlyPayment, extra);
    return {
      monthsSaved: Math.max(0, base.months - accel.months),
      interestSaved: Math.max(0, base.interest - accel.interest),
    };
  }, [type, loans, f]);

  let fields: React.ReactNode = null;

  switch (type) {
    case "job_change": {
      const min = Math.round(income * 0.5);
      const max = Math.round(income * 1.5);
      const value = num("newMonthlyIncome", Math.round(income));
      fields = (
        <>
          <Row>
            <Label>New monthly income: {fmtMoney(value)}</Label>
            <Slider
              min={min || 0}
              max={max || 20000}
              step={100}
              value={[value]}
              onValueChange={([v]) => set("newMonthlyIncome", v)}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{fmtMoney(min)} (−50%)</span>
              <span>Current: {fmtMoney(Math.round(income))}</span>
              <span>{fmtMoney(max)} (+50%)</span>
            </div>
          </Row>
          {dateField("startDate", "When does this happen?")}
          <Row>
            <div className="flex items-center justify-between">
              <Label htmlFor="sf-temporary">Is this temporary?</Label>
              <Switch id="sf-temporary" checked={bool("temporary")} onCheckedChange={(v) => set("temporary", v)} />
            </div>
          </Row>
          {bool("temporary") && numberField("durationMonths", "For how many months?")}
          {numberField("bonus", "Severance or signing bonus (optional)")}
        </>
      );
      break;
    }
    case "buy_home":
      fields = (
        <>
          {numberField("purchasePrice", "Purchase price")}
          {numberField("downPayment", "Down payment amount")}
          <Row>
            <Label htmlFor="sf-mortgageRate">Estimated mortgage rate (%)</Label>
            <Input
              id="sf-mortgageRate"
              type="number"
              step="0.125"
              value={f["mortgageRate"] == null ? "6.5" : String(f["mortgageRate"])}
              onChange={(e) => set("mortgageRate", e.target.value === "" ? undefined : parseFloat(e.target.value))}
            />
          </Row>
          {numberField("monthlyExtras", "Monthly HOA / maintenance")}
          <Row>
            <div className="flex items-center justify-between">
              <Label htmlFor="sf-sell">Will you sell your current home?</Label>
              <Switch id="sf-sell" checked={bool("sellCurrentHome")} onCheckedChange={(v) => set("sellCurrentHome", v)} />
            </div>
          </Row>
          {bool("sellCurrentHome") &&
            (realEstateAsset ? (
              <div className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
                Using your Real Estate asset <span className="font-semibold text-foreground">{realEstateAsset.assetName}</span> as
                estimated sale proceeds:{" "}
                <span className="font-semibold text-foreground">{fmtMoney(realEstateAsset.currentBalance)}</span>
              </div>
            ) : (
              numberField("salePrice", "Estimated sale price of current home ($)")
            ))}
        </>
      );
      break;
    case "new_vehicle":
      fields = (
        <>
          {numberField("vehiclePrice", "Vehicle price")}
          {numberField("downPayment", "Down payment")}
          <Row>
            <Label>Loan term</Label>
            <Select value={String(num("termMonths", 60))} onValueChange={(v) => set("termMonths", parseInt(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[36, 48, 60, 72].map((t) => (
                  <SelectItem key={t} value={String(t)}>{t} months</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {numberField("interestRate", "Interest rate (%)", "7")}
          {numberField("tradeInValue", "Trade-in value (optional)")}
        </>
      );
      break;
    case "major_vacation":
      fields = (
        <>
          {numberField("totalCost", "Total estimated cost")}
          {dateField("startDate", "When?")}
          <Row>
            <Label>How will you pay?</Label>
            <Select value={str("paymentMethod", "cash")} onValueChange={(v) => set("paymentMethod", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="credit_card">Credit card</SelectItem>
                <SelectItem value="savings">Savings</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </>
      );
      break;
    case "extra_debt_payment": {
      const extra = num("extraMonthly", 100);
      fields = (
        <>
          <Row>
            <Label>Which loan?</Label>
            <Select
              value={String(num("loanId", loans?.[0]?.id ?? 0))}
              onValueChange={(v) => set("loanId", parseInt(v))}
            >
              <SelectTrigger><SelectValue placeholder="Select a loan" /></SelectTrigger>
              <SelectContent>
                {(loans ?? []).map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.loanName} — {fmtMoney(l.currentBalance)} at {l.interestRate}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row>
            <Label>Extra monthly payment: {fmtMoney(extra)}</Label>
            <Slider min={50} max={1000} step={25} value={[extra]} onValueChange={([v]) => set("extraMonthly", v)} />
          </Row>
          {debtPreview && (
            <div className="rounded-lg bg-[#56A0D3]/10 px-3 py-2 text-sm text-[#0D2B45]">
              You'd be debt-free <span className="font-semibold">{debtPreview.monthsSaved} months sooner</span> and save{" "}
              <span className="font-semibold">{fmtMoney(Math.round(debtPreview.interestSaved))}</span> in interest.
            </div>
          )}
        </>
      );
      break;
    }
    case "market_downturn": {
      const drop = num("dropPct", 20);
      fields = (
        <>
          <Row>
            <Label>Portfolio drop: −{drop}%</Label>
            <Slider min={10} max={50} step={5} value={[drop]} onValueChange={([v]) => set("dropPct", v)} />
          </Row>
          <Row>
            <Label>Recovery timeline</Label>
            <Select value={String(num("recoveryYears", 2))} onValueChange={(v) => set("recoveryYears", parseInt(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 5].map((y) => (
                  <SelectItem key={y} value={String(y)}>{y} year{y > 1 ? "s" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </>
      );
      break;
    }
    case "education_expense": {
      const total = num("totalCost", 0);
      const years = num("durationYears", 4);
      const monthly = years > 0 ? total / (years * 12) : 0;
      fields = (
        <>
          {numberField("totalCost", "Total cost")}
          {dateField("startDate", "When does it start?")}
          {numberField("durationYears", "Duration (years)", "4")}
          <div className="rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
            Monthly cost: <span className="font-semibold text-foreground">{fmtMoney(Math.round(monthly))}</span>
          </div>
          <Row>
            <Label>Who is this for?</Label>
            <Select value={str("who", "myself")} onValueChange={(v) => set("who", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="myself">Myself</SelectItem>
                <SelectItem value="child">Child</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </>
      );
      break;
    }
    case "growing_family":
      fields = (
        <>
          {numberField("oneTimeCost", "Expected one-time costs (hospital, nursery, etc.)")}
          {numberField("monthlyCost", "Expected monthly ongoing costs (childcare, etc.)")}
          {dateField("startDate", "When?")}
          <Row>
            <div className="flex items-center justify-between">
              <Label htmlFor="sf-incomeChange">Will income change? (parental leave)</Label>
              <Switch id="sf-incomeChange" checked={bool("incomeChange")} onCheckedChange={(v) => set("incomeChange", v)} />
            </div>
          </Row>
        </>
      );
      break;
    case "early_retirement": {
      const currentAge = retirement?.currentAge ?? 40;
      const currentTarget = retirement?.retirementAge ?? 65;
      const value = num("newRetirementAge", currentTarget);
      fields = (
        <Row>
          <Label>New target retirement age: {value}</Label>
          <Slider min={currentAge} max={70} step={1} value={[value]} onValueChange={([v]) => set("newRetirementAge", v)} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Age {currentAge} (now)</span>
            <span>Current plan: {currentTarget}</span>
            <span>70</span>
          </div>
        </Row>
      );
      break;
    }
    case "major_purchase":
      fields = (
        <>
          <Row>
            <Label htmlFor="sf-description">What are you buying?</Label>
            <Input
              id="sf-description"
              value={str("description")}
              placeholder="e.g. Beach house, boat, home theater"
              onChange={(e) => set("description", e.target.value)}
            />
          </Row>
          {numberField("totalCost", "Total cost")}
          {dateField("startDate", "When?")}
          <Row>
            <Label>How will you pay?</Label>
            <Select value={str("paymentMethod", "cash")} onValueChange={(v) => set("paymentMethod", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="financing">Financing</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {str("paymentMethod", "cash") === "financing" && (
            <>
              {numberField("termMonths", "Loan term (months)", "36")}
              {numberField("interestRate", "Interest rate (%)", "9")}
            </>
          )}
        </>
      );
      break;
    case "additional_savings": {
      const extra = num("extraMonthly", 200);
      fields = (
        <>
          <Row>
            <Label>Extra monthly savings: {fmtMoney(extra)}</Label>
            <Slider min={100} max={2000} step={50} value={[extra]} onValueChange={([v]) => set("extraMonthly", v)} />
          </Row>
          <Row>
            <Label>Where will it go?</Label>
            <Select value={str("destination", "general")} onValueChange={(v) => set("destination", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="emergency_fund">Emergency Fund</SelectItem>
                <SelectItem value="retirement">Retirement</SelectItem>
                <SelectItem value="general">General Savings</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {dateField("startDate", "Starting when?")}
        </>
      );
      break;
    }
    case "custom":
      return (
        <div className="space-y-4">
          <div>
            <div className="text-lg font-semibold">{meta.emoji} {meta.name}</div>
            <p className="text-sm text-muted-foreground mt-1">
              Describe your scenario in plain English — Otis will run the numbers.
            </p>
          </div>
          <Textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="e.g. What if I took 6 months off work to travel, then came back at a 10% lower salary?"
            rows={4}
            className="bg-white"
          />
          <Button
            className="bg-[#56A0D3] hover:bg-[#56A0D3]/90 text-white"
            disabled={!customText.trim()}
            onClick={() => onCustomSubmit(customText.trim())}
          >
            Ask Otis 🐾
          </Button>
        </div>
      );
    default:
      fields = null;
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-lg font-semibold">{meta.emoji} {meta.name}</div>
        <p className="text-sm text-muted-foreground mt-1">{meta.description}</p>
      </div>
      <div className="grid gap-4 sm:max-w-md">{fields}</div>
      <Button
        className="bg-[#56A0D3] hover:bg-[#56A0D3]/90 text-white"
        disabled={running}
        onClick={() => {
          const inputs = { ...f };
          if (type === "buy_home" && inputs["sellCurrentHome"] === true) {
            if (realEstateAsset) {
              inputs["salePrice"] = realEstateAsset.currentBalance;
            }
          }
          if (type === "extra_debt_payment") {
            if (inputs["loanId"] == null && loans?.length) inputs["loanId"] = loans[0].id;
            if (inputs["extraMonthly"] == null) inputs["extraMonthly"] = 100;
          }
          if (type === "market_downturn") {
            if (inputs["dropPct"] == null) inputs["dropPct"] = 20;
            if (inputs["recoveryYears"] == null) inputs["recoveryYears"] = 2;
          }
          if (type === "additional_savings" && inputs["extraMonthly"] == null) inputs["extraMonthly"] = 200;
          if (type === "job_change" && inputs["newMonthlyIncome"] == null) inputs["newMonthlyIncome"] = Math.round(income);
          if (type === "early_retirement" && inputs["newRetirementAge"] == null)
            inputs["newRetirementAge"] = retirement?.retirementAge ?? 65;
          onRun(inputs);
        }}
      >
        {running ? "Running…" : "Run Scenario"}
      </Button>
    </div>
  );
}
