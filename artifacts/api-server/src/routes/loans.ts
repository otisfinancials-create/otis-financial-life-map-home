import { Router, type IRouter, type Request } from "express";
import { eq, and } from "drizzle-orm";
import { db, loansTable, billsTable } from "@workspace/db";
import { loanMatchesBill } from "../lib/financial-dedup";
import {
  CreateLoanBody,
  UpdateLoanBody,
  GetLoanParams,
  UpdateLoanParams,
  DeleteLoanParams,
  GetLoanAmortizationParams,
  ListLoansResponse,
  CreateLoanResponse,
  GetLoanResponse,
  UpdateLoanResponse,
  GetLoansSummaryResponse,
  GetLoanAmortizationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type LoanRow = typeof loansTable.$inferSelect;

interface AmortizationEntry {
  paymentNumber: number;
  paymentDate: string;
  paymentAmount: number;
  principal: number;
  interest: number;
  remainingBalance: number;
}

interface AmortizationResult {
  totalInterest: number;
  totalPaid: number;
  payoffDate: string | null;
  numberOfPayments: number;
  schedule: AmortizationEntry[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  // Anchor to the first of the month, then restore the day (clamped to month length).
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

// Generates a full amortization schedule from today's remaining balance until payoff.
// `extraPayment` supports the payoff simulator but the API endpoint always uses 0.
function computeAmortization(loan: LoanRow, extraPayment = 0): AmortizationResult {
  const balance = parseFloat(String(loan.currentBalance));
  const annualRate = parseFloat(String(loan.interestRate));
  const monthlyPayment = parseFloat(String(loan.monthlyPayment)) + extraPayment;
  const monthlyRate = annualRate / 100 / 12;

  const schedule: AmortizationEntry[] = [];
  let remaining = balance;
  let totalInterest = 0;
  const maxPayments = 1200; // 100-year safety cap

  if (balance <= 0 || monthlyPayment <= 0) {
    return { totalInterest: 0, totalPaid: 0, payoffDate: null, numberOfPayments: 0, schedule: [] };
  }

  // If the payment cannot cover the first month's interest, the loan never amortizes.
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
    schedule.push({
      paymentNumber: n,
      paymentDate,
      paymentAmount,
      principal,
      interest,
      remainingBalance: remaining,
    });
    paymentDate = addMonths(paymentDate, 1);
  }

  const totalPaid = round2(schedule.reduce((sum, e) => sum + e.paymentAmount, 0));
  const payoffDate = schedule.length > 0 ? schedule[schedule.length - 1].paymentDate : null;

  return { totalInterest, totalPaid, payoffDate, numberOfPayments: schedule.length, schedule };
}

interface BillSyncResult {
  matched: boolean;
  billName: string;
}

// Keeps the forecast accurate: on loan create/edit, either match an existing
// bill (via loanMatchesBill) or auto-create a monthly "[Loan Name] Payment" bill.
async function syncLoanBill(req: Request, loan: LoanRow): Promise<BillSyncResult> {
  const bills = await db
    .select()
    .from(billsTable)
    .where(eq(billsTable.userId, req.userId));

  const loanForMatch = { loanName: loan.loanName, monthlyPayment: loan.monthlyPayment };
  const match = bills.find((b) =>
    loanMatchesBill(loanForMatch, { billName: b.billName, amount: b.amount }),
  );
  if (match) {
    return { matched: true, billName: match.billName };
  }

  const billName = `${loan.loanName} Payment`;
  const dueDay = Number(loan.nextPaymentDate.slice(8, 10)) || 1;
  await db.insert(billsTable).values({
    userId: req.userId,
    billName,
    amount: String(loan.monthlyPayment),
    frequency: "monthly",
    category: "Debt Payments",
    dueDay,
    isActive: true,
  });
  return { matched: false, billName };
}

router.get("/loans", async (req, res): Promise<void> => {
  req.log.info("Fetching loans");
  const loans = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.userId, req.userId))
    .orderBy(loansTable.loanName);
  res.json(ListLoansResponse.parse(loans.map(serialize)));
});

router.post("/loans", async (req, res): Promise<void> => {
  const parsed = CreateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { originalAmount, currentBalance, interestRate, monthlyPayment, ...rest } = parsed.data;
  const [loan] = await db.insert(loansTable).values({
    ...rest,
    userId: req.userId,
    originalAmount: String(originalAmount),
    currentBalance: String(currentBalance),
    interestRate: String(interestRate),
    monthlyPayment: String(monthlyPayment),
  }).returning();
  const billSync = await syncLoanBill(req, loan);
  res.status(201).json(CreateLoanResponse.parse({ ...serialize(loan), billSync }));
});

router.get("/loans/summary", async (req, res): Promise<void> => {
  const loans = await db
    .select()
    .from(loansTable)
    .where(eq(loansTable.userId, req.userId));

  const totalDebt = loans.reduce((sum, l) => sum + parseFloat(String(l.currentBalance)), 0);
  const totalMonthlyPayments = loans.reduce((sum, l) => sum + parseFloat(String(l.monthlyPayment)), 0);

  const payoffDates = loans
    .map((l) => computeAmortization(l).payoffDate)
    .filter((d): d is string => d !== null)
    .sort();

  const earliestPayoffDate = payoffDates.length > 0 ? payoffDates[0] : null;
  const latestPayoffDate = payoffDates.length > 0 ? payoffDates[payoffDates.length - 1] : null;

  res.json(GetLoansSummaryResponse.parse({
    totalDebt: round2(totalDebt),
    totalMonthlyPayments: round2(totalMonthlyPayments),
    earliestPayoffDate,
    latestPayoffDate,
    loanCount: loans.length,
  }));
});

router.get("/loans/:id", async (req, res): Promise<void> => {
  const params = GetLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [loan] = await db
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.id, params.data.id), eq(loansTable.userId, req.userId)));
  if (!loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  res.json(GetLoanResponse.parse(serialize(loan)));
});

router.get("/loans/:id/amortization", async (req, res): Promise<void> => {
  const params = GetLoanAmortizationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [loan] = await db
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.id, params.data.id), eq(loansTable.userId, req.userId)));
  if (!loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  const result = computeAmortization(loan);
  res.json(GetLoanAmortizationResponse.parse({ loanId: loan.id, ...result }));
});

router.patch("/loans/:id", async (req, res): Promise<void> => {
  const params = UpdateLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateLoanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const {
    originalAmount,
    currentBalance,
    interestRate,
    monthlyPayment,
    ...rest
  } = parsed.data;
  const [loan] = await db
    .update(loansTable)
    .set({
      ...rest,
      ...(originalAmount !== undefined && { originalAmount: String(originalAmount) }),
      ...(currentBalance !== undefined && { currentBalance: String(currentBalance) }),
      ...(interestRate !== undefined && { interestRate: String(interestRate) }),
      ...(monthlyPayment !== undefined && { monthlyPayment: String(monthlyPayment) }),
      updatedAt: new Date(),
    })
    .where(and(eq(loansTable.id, params.data.id), eq(loansTable.userId, req.userId)))
    .returning();
  if (!loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  const billSync = await syncLoanBill(req, loan);
  res.json(UpdateLoanResponse.parse({ ...serialize(loan), billSync }));
});

router.delete("/loans/:id", async (req, res): Promise<void> => {
  const params = DeleteLoanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [loan] = await db
    .delete(loansTable)
    .where(and(eq(loansTable.id, params.data.id), eq(loansTable.userId, req.userId)))
    .returning();
  if (!loan) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  res.sendStatus(204);
});

function serialize(l: LoanRow) {
  return {
    ...l,
    originalAmount: parseFloat(String(l.originalAmount)),
    currentBalance: parseFloat(String(l.currentBalance)),
    interestRate: parseFloat(String(l.interestRate)),
    monthlyPayment: parseFloat(String(l.monthlyPayment)),
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

export default router;
