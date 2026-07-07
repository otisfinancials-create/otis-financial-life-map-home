export interface ScenarioMeta {
  type: string;
  emoji: string;
  name: string;
  description: string;
}

export const SCENARIO_CARDS: ScenarioMeta[] = [
  { type: "job_change", emoji: "💼", name: "Job Change", description: "What if your income changed?" },
  { type: "buy_home", emoji: "🏠", name: "Buy a Home", description: "What if you bought or upgraded your home?" },
  { type: "new_vehicle", emoji: "🚗", name: "New Vehicle", description: "What if you bought a new car?" },
  { type: "major_vacation", emoji: "✈️", name: "Major Vacation", description: "What if you took the trip of a lifetime?" },
  { type: "extra_debt_payment", emoji: "💰", name: "Extra Debt Payment", description: "What if you paid down debt faster?" },
  { type: "market_downturn", emoji: "📈", name: "Market Downturn", description: "What if your investments dropped?" },
  { type: "education_expense", emoji: "🎓", name: "Education Expense", description: "What if you invested in education?" },
  { type: "growing_family", emoji: "👶", name: "Growing the Family", description: "What if your family grew?" },
  { type: "early_retirement", emoji: "🏖️", name: "Early Retirement", description: "What if you retired sooner?" },
  { type: "major_purchase", emoji: "💳", name: "Major Purchase", description: "What if you made a big purchase?" },
  { type: "additional_savings", emoji: "💵", name: "Additional Savings", description: "What if you saved more each month?" },
  { type: "custom", emoji: "✏️", name: "Custom Scenario", description: "Something else on your mind? Describe it." },
];

export function scenarioMeta(type: string): ScenarioMeta {
  return (
    SCENARIO_CARDS.find((c) => c.type === type) ?? {
      type,
      emoji: "✨",
      name: type.replace(/_/g, " "),
      description: "",
    }
  );
}

export interface ScenarioResultData {
  monthlyCashFlowImpact: number;
  netWorthImpactOneYear: number;
  retirementImpactLabel: string;
  points: { monthIndex: number; label: string; baseline: number; scenario: number }[];
  commentary: string;
}

export function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function fmtSigned(v: number): string {
  const abs = Math.abs(v);
  return `${v < 0 ? "−" : "+"}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
