const num = (v: unknown) => parseFloat(String(v)) || 0;

const norm = (s: string) => s.trim().toLowerCase();

/**
 * A loan is "already represented" by a negative/liability Connected Account when
 * it shares the same name (case-insensitive) or the same monthly payment.
 * In that case the Connected Account balance is the source of truth and the
 * loan must not be double-counted in liabilities / net worth.
 */
export function loanRepresentedByAccount(
  loan: { loanName: string; monthlyPayment: unknown },
  liabilityAccounts: { accountName: string; monthlyContribution?: unknown }[],
): boolean {
  const loanName = norm(loan.loanName);
  const loanPayment = num(loan.monthlyPayment);
  return liabilityAccounts.some((a) => {
    if (norm(a.accountName) === loanName) return true;
    const acctPayment = num(a.monthlyContribution);
    return acctPayment > 0 && Math.abs(acctPayment - loanPayment) < 0.005;
  });
}

/** Loans not already represented in Connected Accounts (deduplicated). */
export function dedupedLoans<T extends { loanName: string; monthlyPayment: unknown }>(
  loans: T[],
  liabilityAccounts: { accountName: string; monthlyContribution?: unknown }[],
): T[] {
  return loans.filter((l) => !loanRepresentedByAccount(l, liabilityAccounts));
}

/**
 * A loan payment duplicates a bill when the names closely match
 * (case-insensitive partial match) or the amounts are within 5%.
 */
export function loanMatchesBill(
  loan: { loanName: string; monthlyPayment: unknown },
  bill: { billName: string; amount: unknown },
): boolean {
  const ln = norm(loan.loanName);
  const bn = norm(bill.billName);
  if (ln && bn && (ln.includes(bn) || bn.includes(ln))) return true;
  const lp = num(loan.monthlyPayment);
  const ba = num(bill.amount);
  if (lp <= 0 || ba <= 0) return false;
  return Math.abs(lp - ba) / ba <= 0.05;
}
