/**
 * Seed script — inserts sample bills, a pay schedule, and regenerates the forecast.
 *
 * Required env var:
 *   SEED_USER_ID — Clerk user ID string (format: "user_xxxx...")
 *   DATABASE_URL — Postgres connection string (auto-provided by Replit)
 *
 * Usage:
 *   SEED_USER_ID=user_xxxx pnpm --filter @workspace/scripts run seed
 *
 * To find your Clerk user ID: Clerk Dashboard → Users, or in the browser console:
 *   (await window.Clerk.user).id
 */

import { db, billsTable, paySchedulesTable, forecastedTransactionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const rawUserId = process.env.SEED_USER_ID;
if (!rawUserId) {
  console.error("Error: SEED_USER_ID env var is required.");
  console.error("  Get it from Clerk Dashboard → Users, or in the browser: (await window.Clerk.user).id");
  console.error("  Usage: SEED_USER_ID=user_xxxx pnpm --filter @workspace/scripts run seed");
  process.exit(1);
}
const userId: string = rawUserId;

function nextWeekdayDate(offsetDays = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function advanceByFrequency(date: Date, frequency: string): Date {
  const d = new Date(date);
  switch (frequency.toLowerCase()) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "biweekly":
    case "bi-weekly":
      d.setDate(d.getDate() + 14);
      break;
    case "semi-monthly":
    case "semimonthly":
      if (d.getDate() < 15) {
        d.setDate(15);
      } else {
        d.setMonth(d.getMonth() + 1);
        d.setDate(1);
      }
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "semi-annual":
    case "semiannual":
    case "biannual":
      d.setMonth(d.getMonth() + 6);
      break;
    case "annual":
    case "annually":
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      d.setMonth(d.getMonth() + 1);
  }
  return d;
}

async function seed() {
  console.log(`Seeding for user: ${userId}`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const insertedBills = await db
    .insert(billsTable)
    .values([
      {
        userId,
        billName: "Rent",
        category: "Housing",
        amount: "2800.00",
        frequency: "monthly",
        dueDay: 1,
        isActive: true,
        isVariable: false,
        notes: "Primary residence",
      },
      {
        userId,
        billName: "Netflix",
        category: "Subscriptions",
        amount: "15.99",
        frequency: "monthly",
        dueDay: 15,
        isActive: true,
        isVariable: false,
        companyUrl: "https://netflix.com",
        paymentMethod: "credit-card",
      },
      {
        userId,
        billName: "Car Insurance",
        category: "Insurance",
        amount: "450.00",
        frequency: "semi-annual",
        dueDay: 1,
        isActive: true,
        isVariable: false,
        paymentMethod: "auto-pay",
      },
      {
        userId,
        billName: "Gym Membership",
        category: "Health",
        amount: "15.00",
        frequency: "weekly",
        dueDay: 1,
        isActive: true,
        isVariable: false,
        paymentMethod: "credit-card",
      },
      {
        userId,
        billName: "Electric Bill",
        category: "Utilities",
        amount: "120.00",
        frequency: "monthly",
        dueDay: 20,
        isActive: true,
        isVariable: true,
        notes: "Varies by season",
      },
    ])
    .returning();

  console.log(`Inserted ${insertedBills.length} bills.`);

  const nextPayDate = nextWeekdayDate(7);
  const insertedSchedules = await db
    .insert(paySchedulesTable)
    .values([
      {
        userId,
        employerName: "Acme Corp",
        amount: "4500.00",
        frequency: "biweekly",
        nextPayDate,
        notes: "Primary employment, direct deposit",
      },
    ])
    .returning();

  console.log(`Inserted ${insertedSchedules.length} pay schedule(s). Next pay date: ${nextPayDate}`);

  // Forecast regeneration is done inline rather than via POST /api/forecast/regenerate
  // because that endpoint requires Clerk auth — a CLI script has no browser session token.
  // This logic mirrors the route exactly; keep both in sync when changing the engine.
  console.log("Regenerating forecast...");

  await db.delete(forecastedTransactionsTable).where(
    and(
      eq(forecastedTransactionsTable.isActual, false),
      eq(forecastedTransactionsTable.userId, userId)
    )
  );

  const endDate = new Date(today.getFullYear(), today.getMonth() + 12, 0);
  const toInsert: Array<typeof forecastedTransactionsTable.$inferInsert> = [];

  const activeBills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), eq(billsTable.userId, userId)));

  for (const bill of activeBills) {
    const amount = parseFloat(String(bill.amount));
    let current = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (current < today) {
      current = advanceByFrequency(current, bill.frequency);
    }
    while (current <= endDate) {
      toInsert.push({
        userId,
        transactionDate: current.toISOString().split("T")[0],
        description: bill.billName,
        amount: String(amount),
        transactionType: "expense",
        category: bill.category,
        sourceBillId: bill.id,
        isActual: false,
        isCommitted: false,
      });
      current = advanceByFrequency(current, bill.frequency);
    }
  }

  const allSchedules = await db
    .select()
    .from(paySchedulesTable)
    .where(eq(paySchedulesTable.userId, userId));

  for (const ps of allSchedules) {
    const amount = parseFloat(String(ps.amount));
    let current = new Date(ps.nextPayDate + "T00:00:00");
    while (current <= endDate) {
      if (current >= today) {
        toInsert.push({
          userId,
          transactionDate: current.toISOString().split("T")[0],
          description: `Paycheck – ${ps.employerName}`,
          amount: String(amount),
          transactionType: "income",
          category: "salary",
          sourcePayId: ps.id,
          isActual: false,
          isCommitted: false,
        });
      }
      current = advanceByFrequency(current, ps.frequency);
    }
  }

  if (toInsert.length > 0) {
    await db.insert(forecastedTransactionsTable).values(toInsert);
  }

  console.log(`Created ${toInsert.length} forecasted transactions.`);
  console.log("\nSeed complete! Open the dashboard to see your data.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
