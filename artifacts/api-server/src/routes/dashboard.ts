import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, accountsTable, billsTable } from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  req.log.info("Fetching dashboard summary");

  const [accounts, bills] = await Promise.all([
    db.select().from(accountsTable),
    db.select().from(billsTable).where(eq(billsTable.isActive, true)),
  ]);

  const totalAssets = accounts
    .filter((a) => a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const totalLiabilities = accounts
    .filter((a) => !a.isAsset)
    .reduce((sum, a) => sum + parseFloat(String(a.currentBalance)), 0);
  const netWorth = totalAssets - totalLiabilities;

  // Monthly calculations based on bills
  const monthlyExpenses = bills.reduce((sum, b) => {
    const amount = parseFloat(String(b.amount));
    const freq = b.frequency.toLowerCase();
    if (freq === "weekly") return sum + amount * 4.33;
    if (freq === "biweekly" || freq === "bi-weekly") return sum + amount * 2.17;
    if (freq === "quarterly") return sum + amount / 3;
    if (freq === "annually" || freq === "yearly") return sum + amount / 12;
    return sum + amount; // monthly
  }, 0);

  // Upcoming bills in next 30 days
  const today = new Date();
  const upcomingBills = bills.filter((bill) => {
    let dueDate = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (dueDate < today) {
      dueDate = new Date(today.getFullYear(), today.getMonth() + 1, bill.dueDay);
    }
    const days = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return days <= 30;
  });

  const billsDueThisWeek = bills.filter((bill) => {
    let dueDate = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (dueDate < today) {
      dueDate = new Date(today.getFullYear(), today.getMonth() + 1, bill.dueDay);
    }
    const days = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return days <= 7;
  }).length;

  const upcomingBillsTotal = upcomingBills.reduce((sum, b) => sum + parseFloat(String(b.amount)), 0);

  // Placeholder: income will come from pay schedules later
  const monthlyIncome = monthlyExpenses * 1.4; // will be replaced with real pay schedule data
  const monthlyCashFlow = monthlyIncome - monthlyExpenses;

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
