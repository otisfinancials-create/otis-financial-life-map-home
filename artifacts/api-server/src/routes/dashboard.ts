import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, accountsTable, billsTable, paySchedulesTable } from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";

const FREQ_TO_MONTHLY: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  "bi-weekly": 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
  yearly: 1 / 12,
};

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  req.log.info("Fetching dashboard summary");

  const [accounts, bills, paySchedules] = await Promise.all([
    db.select().from(accountsTable).where(eq(accountsTable.userId, req.userId)),
    db.select().from(billsTable).where(eq(billsTable.userId, req.userId)),
    db.select().from(paySchedulesTable).where(eq(paySchedulesTable.userId, req.userId)),
  ]);

  const activeBills = bills.filter((b) => b.isActive);

  // Net worth
  const totalAssets = accounts
    .filter((a) => a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const totalLiabilities = accounts
    .filter((a) => !a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  // Monthly expenses from active bills
  const monthlyExpenses = activeBills.reduce((sum, b) => {
    const amount = parseFloat(String(b.amount));
    const multiplier = FREQ_TO_MONTHLY[b.frequency.toLowerCase()] ?? 1;
    return sum + amount * multiplier;
  }, 0);

  // Monthly income from real pay schedules
  const monthlyIncome = paySchedules.reduce((sum, ps) => {
    const amount = parseFloat(String(ps.amount));
    const multiplier = FREQ_TO_MONTHLY[ps.frequency.toLowerCase()] ?? 1;
    return sum + amount * multiplier;
  }, 0);

  const monthlyCashFlow = monthlyIncome - monthlyExpenses;

  // Upcoming bills in next 30 days
  const today = new Date();
  const upcomingBills = activeBills.filter((bill) => {
    let dueDate = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (dueDate < today) {
      dueDate = new Date(today.getFullYear(), today.getMonth() + 1, bill.dueDay);
    }
    const days = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return days <= 30;
  });

  const billsDueThisWeek = activeBills.filter((bill) => {
    let dueDate = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (dueDate < today) {
      dueDate = new Date(today.getFullYear(), today.getMonth() + 1, bill.dueDay);
    }
    const days = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return days <= 7;
  }).length;

  const upcomingBillsTotal = upcomingBills.reduce(
    (sum, b) => sum + parseFloat(String(b.amount)),
    0
  );

  res.json(
    GetDashboardSummaryResponse.parse({
      netWorth,
      totalAssets,
      totalLiabilities,
      monthlyIncome,
      monthlyExpenses,
      monthlyCashFlow,
      upcomingBillsCount: upcomingBills.length,
      upcomingBillsTotal,
      billsDueThisWeek,
    })
  );
});

export default router;
