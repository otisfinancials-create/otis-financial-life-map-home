// Convert a bill amount at a given frequency to its monthly equivalent.
// `customIntervalDays` is required to price frequency='custom' (interval days
// → occurrences per year → monthly factor).
export function monthlyFactor(frequency: string, customIntervalDays?: number | null): number {
  switch (frequency.toLowerCase()) {
    case "weekly": return 52 / 12;
    case "biweekly": case "bi-weekly": return 26 / 12;
    case "semi-monthly": case "semimonthly": return 2;
    case "monthly": return 1;
    case "quarterly": return 1 / 3;
    case "semi-annual": case "semiannual": case "biannual": return 1 / 6;
    case "annual": case "annually": case "yearly": return 1 / 12;
    case "custom":
      return customIntervalDays && customIntervalDays > 0
        ? 365.25 / customIntervalDays / 12
        : 1;
    default:
      // Cadences are validated at the API boundary, so this indicates drift
      // between client pricing and the server cadence set. Loud, not silent.
      console.error(`monthlyFactor: unknown frequency "${frequency}" — pricing as monthly`);
      return 1;
  }
}
