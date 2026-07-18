export interface ScenarioAmortEntry {
  paymentNumber: number;
  paymentDate: string;
  paymentAmount: number;
  principal: number;
  interest: number;
  remainingBalance: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

export interface ScenarioAmortResult {
  monthlyPayment: number;
  totalInterest: number;
  totalPaid: number;
  schedule: ScenarioAmortEntry[];
}

// Standard fixed-rate amortization computed entirely client-side from scenario
// inputs — mirrors the Loans amortization table format.
export function computeScenarioAmortization(
  principal: number,
  annualRatePct: number,
  termMonths: number,
  startDateIso?: string,
): ScenarioAmortResult | null {
  if (!(principal > 0) || !(termMonths > 0)) return null;

  const r = annualRatePct / 100 / 12;
  const monthlyPayment =
    r > 0
      ? (principal * r) / (1 - Math.pow(1 + r, -termMonths))
      : principal / termMonths;

  if (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0) return null;

  const start = startDateIso && /^\d{4}-\d{2}-\d{2}$/.test(startDateIso)
    ? startDateIso
    : new Date().toISOString().slice(0, 10);

  const schedule: ScenarioAmortEntry[] = [];
  let remaining = principal;
  let totalInterest = 0;
  let paymentDate = addMonths(start, 1);

  for (let n = 1; n <= termMonths && remaining > 0.005; n += 1) {
    const interest = round2(remaining * r);
    let principalPaid = round2(monthlyPayment - interest);
    if (principalPaid > remaining) principalPaid = round2(remaining);
    const paymentAmount = round2(principalPaid + interest);
    remaining = round2(remaining - principalPaid);
    totalInterest = round2(totalInterest + interest);
    schedule.push({
      paymentNumber: n,
      paymentDate,
      paymentAmount,
      principal: principalPaid,
      interest,
      remainingBalance: remaining,
    });
    paymentDate = addMonths(paymentDate, 1);
  }

  const totalPaid = round2(schedule.reduce((sum, e) => sum + e.paymentAmount, 0));
  return { monthlyPayment: round2(monthlyPayment), totalInterest, totalPaid, schedule };
}

interface AmortInputs {
  principal: number;
  annualRatePct: number;
  termMonths: number;
  startDate?: string;
}

// Derives amortization inputs from scenario form inputs for the three financing
// scenarios that show a schedule (#39). Returns null when not financed.
export function scenarioAmortInputs(type: string, inputs: Record<string, unknown>): AmortInputs | null {
  const num = (k: string, fallback = 0): number => {
    const v = inputs[k];
    const parsed = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const str = (k: string): string | undefined => (typeof inputs[k] === "string" ? (inputs[k] as string) : undefined);

  switch (type) {
    case "major_purchase": {
      if (inputs["paymentMethod"] !== "financing") return null;
      const principal = num("totalCost");
      return { principal, annualRatePct: num("interestRate", 9), termMonths: num("termMonths", 36), startDate: str("startDate") };
    }
    case "new_vehicle": {
      const principal = num("vehiclePrice") - num("downPayment") - num("tradeInValue");
      return { principal, annualRatePct: num("interestRate", 7), termMonths: num("termMonths", 60) };
    }
    case "buy_home": {
      const principal = num("purchasePrice") - num("downPayment");
      return { principal, annualRatePct: num("mortgageRate", 6.5), termMonths: 360 };
    }
    default:
      return null;
  }
}
