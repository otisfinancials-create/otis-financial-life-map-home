import { Router, type IRouter, type Request } from "express";
import { eq, and } from "drizzle-orm";
import { db, loansTable, billsTable, accountsTable } from "@workspace/db";
import { loanMatchesBill, loanRepresentedByAccount } from "../lib/financial-dedup";
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

/**
 * Effective balance for schedule math: a loan linked to an account has NO
 * balance of its own — the account owns it (|account.currentBalance|).
 */
async function effectiveBalance(loan: LoanRow, userId: string): Promise<number> {
  // Linked → the account ALWAYS owns the balance, even if a stale loan
  // balance is still stored. Only unlinked loans use their own balance.
  if (loan.accountId != null) {
    const [acct] = await db
      .select({ currentBalance: accountsTable.currentBalance })
      .from(accountsTable)
      .where(and(eq(accountsTable.id, loan.accountId), eq(accountsTable.userId, userId)));
    if (acct) return Math.abs(parseFloat(String(acct.currentBalance)));
  }
  return loan.currentBalance != null ? parseFloat(String(loan.currentBalance)) : 0;
}

// Generates a full amortization schedule from today's remaining balance until payoff.
// `extraPayment` supports the payoff simulator but the API endpoint always uses 0.
function computeAmortization(loan: LoanRow, extraPayment = 0, balanceOverride?: number): AmortizationResult {
  const balance = balanceOverride ?? parseFloat(String(loan.currentBalance ?? "0"));
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

async function isLinkableAccount(userId: string, accountId: number): Promise<boolean> {
  const [acct] = await db
    .select({ isAsset: accountsTable.isAsset })
    .from(accountsTable)
    .where(and(eq(accountsTable.id, accountId), eq(accountsTable.userId, userId)));
  return !!acct && !acct.isAsset;
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
  const { originalAmount, currentBalance, accountId, interestRate, monthlyPayment, ...rest } = parsed.data;
  if (currentBalance == null && accountId == null) {
    res.status(400).json({ error: "currentBalance is required unless the loan is linked to an account" });
    return;
  }
  if (accountId != null && !(await isLinkableAccount(req.userId, accountId))) {
    res.status(400).json({ error: "accountId must be one of your liability accounts" });
    return;
  }
  const [loan] = await db.insert(loansTable).values({
    ...rest,
    userId: req.userId,
    accountId: accountId ?? null,
    originalAmount: String(originalAmount),
    // Linked → the account owns the balance; never store a shadow copy.
    currentBalance: accountId == null && currentBalance != null ? String(currentBalance) : null,
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

  const balances = await Promise.all(loans.map((l) => effectiveBalance(l, req.userId)));
  const totalDebt = balances.reduce((sum, b) => sum + b, 0);
  const totalMonthlyPayments = loans.reduce((sum, l) => sum + parseFloat(String(l.monthlyPayment)), 0);

  const payoffDates = loans
    .map((l, i) => computeAmortization(l, 0, balances[i]).payoffDate)
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

/**
 * ONE-TIME heuristic pass over existing data: suggests account links for
 * unlinked loans using the retired name/payment heuristic. Suggestion only —
 * the user confirms via PATCH /loans/:id/link. The heuristic no longer
 * participates in any liabilities calculation.
 */
router.get("/loans/link-suggestions", async (req, res): Promise<void> => {
  const [loans, accounts] = await Promise.all([
    db.select().from(loansTable).where(eq(loansTable.userId, req.userId)),
    db.select().from(accountsTable).where(eq(accountsTable.userId, req.userId)),
  ]);
  const liabilityAccounts = accounts.filter((a) => !a.isAsset);
  const linkedAccountIds = new Set(loans.map((l) => l.accountId).filter((id): id is number => id != null));
  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const suggestions: Array<{ loanId: number; loanName: string; accountId: number; accountName: string; reason: string }> = [];
  for (const loan of loans) {
    if (loan.accountId != null) continue;
    for (const acct of liabilityAccounts) {
      if (linkedAccountIds.has(acct.id)) continue;
      const ln = norm(loan.loanName);
      const an = norm(acct.accountName);
      const nameMatch = !!ln && !!an && (ln.includes(an) || an.includes(ln) || loanRepresentedByAccount(loan, [acct]));
      const lb = loan.currentBalance != null ? parseFloat(String(loan.currentBalance)) : null;
      const ab = Math.abs(parseFloat(String(acct.currentBalance)));
      const balanceClose = lb != null && ab > 0 && Math.abs(lb - ab) / ab <= 0.05;
      if (nameMatch || balanceClose) {
        suggestions.push({
          loanId: loan.id,
          loanName: loan.loanName,
          accountId: acct.id,
          accountName: acct.accountName,
          reason: nameMatch ? "Names look like the same debt" : "Balances are within 5%",
        });
        break;
      }
    }
  }
  res.json({ suggestions });
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
  const result = computeAmortization(loan, 0, await effectiveBalance(loan, req.userId));
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
    accountId,
    interestRate,
    monthlyPayment,
    ...rest
  } = parsed.data;
  const [existing] = await db
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.id, params.data.id), eq(loansTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  const nextBalance = currentBalance !== undefined ? currentBalance : (existing.currentBalance != null ? parseFloat(String(existing.currentBalance)) : null);
  const nextAccountId = accountId !== undefined ? accountId : existing.accountId;
  if (nextBalance == null && nextAccountId == null) {
    res.status(400).json({ error: "currentBalance is required unless the loan is linked to an account" });
    return;
  }
  if (accountId != null && !(await isLinkableAccount(req.userId, accountId))) {
    res.status(400).json({ error: "accountId must be one of your liability accounts" });
    return;
  }
  const [loan] = await db
    .update(loansTable)
    .set({
      ...rest,
      ...(originalAmount !== undefined && { originalAmount: String(originalAmount) }),
      ...(accountId !== undefined && { accountId }),
      // Linked → the account owns the balance; clear any stored copy so
      // nothing can ever read a stale number.
      ...(nextAccountId != null
        ? { currentBalance: null }
        : currentBalance !== undefined && { currentBalance: currentBalance != null ? String(currentBalance) : null }),
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

router.patch("/loans/:id/link", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid loan id" });
    return;
  }
  const accountId = req.body?.accountId;
  if (accountId !== null && !Number.isInteger(accountId)) {
    res.status(400).json({ error: "accountId must be an integer or null" });
    return;
  }
  const [existing] = await db
    .select()
    .from(loansTable)
    .where(and(eq(loansTable.id, id), eq(loansTable.userId, req.userId)));
  if (!existing) {
    res.status(404).json({ error: "Loan not found" });
    return;
  }
  if (accountId != null && !(await isLinkableAccount(req.userId, accountId))) {
    res.status(400).json({ error: "accountId must be one of your liability accounts" });
    return;
  }
  // Unlinking: the loan needs a balance of its own again. Accept one in the
  // body; default to the linked account's current |balance| so the number
  // stays continuous at the moment of unlink.
  let unlinkBalance: string | null = null;
  if (accountId == null) {
    const supplied = req.body?.currentBalance;
    if (supplied !== undefined && supplied !== null && (typeof supplied !== "number" || !(supplied >= 0))) {
      res.status(400).json({ error: "currentBalance must be a non-negative number" });
      return;
    }
    if (typeof supplied === "number") {
      unlinkBalance = String(supplied);
    } else if (existing.currentBalance != null) {
      unlinkBalance = String(existing.currentBalance);
    } else if (existing.accountId != null) {
      unlinkBalance = String(await effectiveBalance(existing, req.userId));
    } else {
      res.status(400).json({ error: "Provide a currentBalance to unlink this loan." });
      return;
    }
  }
  const [loan] = await db
    .update(loansTable)
    .set({
      accountId,
      // Linking clears the stored balance (account owns it); unlinking restores one.
      currentBalance: accountId == null ? unlinkBalance : null,
      updatedAt: new Date(),
    })
    .where(and(eq(loansTable.id, id), eq(loansTable.userId, req.userId)))
    .returning();
  res.json(GetLoanResponse.parse(serialize(loan)));
});

function serialize(l: LoanRow) {
  return {
    ...l,
    originalAmount: parseFloat(String(l.originalAmount)),
    currentBalance: l.currentBalance != null ? parseFloat(String(l.currentBalance)) : null,
    interestRate: parseFloat(String(l.interestRate)),
    monthlyPayment: parseFloat(String(l.monthlyPayment)),
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

export default router;
