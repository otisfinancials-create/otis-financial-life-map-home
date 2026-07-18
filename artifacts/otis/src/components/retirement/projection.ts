export interface ProjectionPoint {
  age: number;
  year: number;
  projected: number;
}

// Mirrors the server-side projection: monthly compounding with monthly
// contributions, reported year by year from current age to retirement age.
export function projectRetirement(
  currentSavings: number,
  monthlyContribution: number,
  currentAge: number,
  retirementAge: number,
  annualReturnPct: number,
): ProjectionPoint[] {
  const monthlyRate = annualReturnPct / 100 / 12;
  const startYear = new Date().getFullYear();
  const points: ProjectionPoint[] = [];
  let balance = currentSavings;
  points.push({ age: currentAge, year: startYear, projected: Math.round(balance) });
  for (let age = currentAge + 1; age <= retirementAge; age++) {
    for (let m = 0; m < 12; m++) {
      balance = balance * (1 + monthlyRate) + monthlyContribution;
    }
    points.push({ age, year: startYear + (age - currentAge), projected: Math.round(balance) });
  }
  return points;
}

export const RETIREMENT_SUBTYPE_LABELS: Record<string, string> = {
  "401k": "401(k)",
  ira: "IRA",
  roth_ira: "Roth IRA",
  pension: "Pension",
  other: "Other",
};

export const RETIREMENT_ACCOUNT_TYPES = ["retirement"];
