// Convert a bill amount at a given frequency to its monthly equivalent.
export function monthlyFactor(frequency: string): number {
  switch (frequency.toLowerCase()) {
    case "weekly": return 52 / 12;
    case "biweekly": case "bi-weekly": return 26 / 12;
    case "semi-monthly": case "semimonthly": return 2;
    case "monthly": return 1;
    case "quarterly": return 1 / 3;
    case "semi-annual": case "semiannual": case "biannual": return 1 / 6;
    case "annual": case "annually": case "yearly": return 1 / 12;
    default: return 1;
  }
}
