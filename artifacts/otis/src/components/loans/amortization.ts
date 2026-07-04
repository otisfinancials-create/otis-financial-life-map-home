import type { Loan } from "@workspace/api-client-react";

export interface AmortizationEntry {
  paymentNumber: number;
  paymentDate: string;
  paymentAmount: number;
  principal: number;
  interest: number;
  remainingBalance: number;
}

export interface AmortizationResult {
  totalInterest: number;
  totalPaid: number;
  payoffDate: string | null;
  numberOfPayments: number;
  schedule: AmortizationEntry[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

// Mirrors the server-side amortization engine so the extra-payment simulator can
// recompute payoff scenarios instantly in the browser without an extra request.
export function computeAmortization(loan: Loan, extraPayment = 0): AmortizationResult {
  const balance = loan.currentBalance;
  const monthlyPayment = loan.monthlyPayment + extraPayment;
  const monthlyRate = loan.interestRate / 100 / 12;

  const schedule: AmortizationEntry[] = [];
  let remaining = balance;
  let totalInterest = 0;
  const maxPayments = 1200;

  if (balance <= 0 || monthlyPayment <= 0) {
    return { totalInterest: 0, totalPaid: 0, payoffDate: null, numberOfPayments: 0, schedule: [] };
  }
  if (monthlyRate > 0 && monthlyPayment <= remaining * monthlyRate) {
    return { totalInterest: 0, totalPaid: 0, payoffDate: null, numberOfPayments: 0, schedule: [] };
  }

  let paymentDate = loan.nextPaymentDate;
  let n = 0;
  while (remaining > 0.005 && n < maxPayments) {
    n += 1;
    const interest = round2(remaining * monthlyRate);
    let principal = round2(monthlyPayment - interest);
    if (principal > remaining) principal = round2(remaining);
    const paymentAmount = round2(principal + interest);
    remaining = round2(remaining - principal);
    totalInterest = round2(totalInterest + interest);
    schedule.push({ paymentNumber: n, paymentDate, paymentAmount, principal, interest, remainingBalance: remaining });
    paymentDate = addMonths(paymentDate, 1);
  }

  const totalPaid = round2(schedule.reduce((sum, e) => sum + e.paymentAmount, 0));
  const payoffDate = schedule.length > 0 ? schedule[schedule.length - 1].paymentDate : null;
  return { totalInterest, totalPaid, payoffDate, numberOfPayments: schedule.length, schedule };
}

export interface YearlyRow {
  year: number;
  paymentTotal: number;
  principalTotal: number;
  interestTotal: number;
  endingBalance: number;
}

export function toYearly(schedule: AmortizationEntry[]): YearlyRow[] {
  const byYear = new Map<number, YearlyRow>();
  for (const entry of schedule) {
    const year = Number(entry.paymentDate.slice(0, 4));
    const existing = byYear.get(year) ?? {
      year,
      paymentTotal: 0,
      principalTotal: 0,
      interestTotal: 0,
      endingBalance: entry.remainingBalance,
    };
    existing.paymentTotal = round2(existing.paymentTotal + entry.paymentAmount);
    existing.principalTotal = round2(existing.principalTotal + entry.principal);
    existing.interestTotal = round2(existing.interestTotal + entry.interest);
    existing.endingBalance = entry.remainingBalance;
    byYear.set(year, existing);
  }
  return Array.from(byYear.values()).sort((a, b) => a.year - b.year);
}
