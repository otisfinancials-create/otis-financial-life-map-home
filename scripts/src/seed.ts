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

import { db, billsTable, paySchedulesTable, forecastedTransactionsTable, lifeEventsTable, userSettingsTable } from "@workspace/db";
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

function toLocalIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

function advanceIsoByFrequency(iso: string, frequency: string): string {
  switch (frequency.toLowerCase()) {
    case "monthly":
      return addMonthsIso(iso, 1);
    case "quarterly":
      return addMonthsIso(iso, 3);
    case "annual":
    case "annually":
    case "yearly":
      return addMonthsIso(iso, 12);
    default:
      return addMonthsIso(iso, 12);
  }
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

  const year = today.getFullYear();
  const insertedLifeEvents = await db
    .insert(lifeEventsTable)
    .values([
      {
        userId,
        eventName: "European Vacation",
        category: "vacations",
        amount: "6500.00",
        timingType: "one_time",
        eventDate: `${year}-08-15`,
        priority: "planning_to",
        notes: "Two weeks, flights and hotels",
        isActive: true,
      },
      {
        userId,
        eventName: "New Puppy",
        category: "pets",
        amount: "2200.00",
        timingType: "one_time",
        eventDate: `${year + 1}-07-01`,
        priority: "just_dreaming",
        notes: "Adoption plus first-year supplies",
        isActive: true,
      },
      {
        userId,
        eventName: "Kitchen Remodel",
        category: "home_improvements",
        amount: "24000.00",
        timingType: "spread",
        startDate: `${year + 1}-01-01`,
        endDate: `${year + 1}-06-30`,
        priority: "planning_to",
        notes: "Cabinets, counters, appliances",
        isActive: true,
      },
      {
        userId,
        eventName: "Christmas Gifts",
        category: "celebrations",
        amount: "1500.00",
        timingType: "recurring",
        startDate: `${year}-12-01`,
        frequency: "annually",
        priority: "must_do",
        notes: "Family and friends",
        isActive: true,
      },
      {
        userId,
        eventName: "Car Service",
        category: "vehicle",
        amount: "600.00",
        timingType: "recurring",
        startDate: `${year}-10-01`,
        frequency: "annually",
        priority: "must_do",
        notes: "Annual maintenance",
        isActive: true,
      },
    ])
    .returning();

  console.log(`Inserted ${insertedLifeEvents.length} life event(s).`);

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

  const activeLifeEvents = await db
    .select()
    .from(lifeEventsTable)
    .where(and(eq(lifeEventsTable.isActive, true), eq(lifeEventsTable.userId, userId)));

  const todayStr = toLocalIso(today);
  const endStr = toLocalIso(endDate);

  for (const ev of activeLifeEvents) {
    const total = parseFloat(String(ev.amount));
    const category = ev.category === "custom" && ev.customCategory ? ev.customCategory : ev.category;

    const pushRow = (dateStr: string, amount: number, description: string) => {
      toInsert.push({
        userId,
        transactionDate: dateStr,
        description,
        amount: String(Math.round(amount * 100) / 100),
        transactionType: "expense",
        category,
        sourceLifeEventId: ev.id,
        isActual: false,
        isCommitted: false,
      });
    };

    if (ev.timingType === "one_time" && ev.eventDate) {
      if (ev.eventDate >= todayStr && ev.eventDate <= endStr) {
        pushRow(ev.eventDate, total, ev.eventName);
      }
    } else if (ev.timingType === "spread" && ev.startDate && ev.endDate) {
      const [sy, sm] = ev.startDate.split("-").map(Number);
      const [ey, em] = ev.endDate.split("-").map(Number);
      const months = (ey - sy) * 12 + (em - sm) + 1;
      if (months > 0) {
        const perMonth = total / months;
        let current = ev.startDate;
        for (let i = 0; i < months; i++) {
          if (current >= todayStr && current <= endStr) {
            pushRow(current, perMonth, `${ev.eventName} (${i + 1}/${months})`);
          }
          current = addMonthsIso(current, 1);
        }
      }
    } else if (ev.timingType === "recurring" && ev.startDate) {
      const frequency = ev.frequency ?? "annually";
      const recurEndStr = ev.endDate && ev.endDate < endStr ? ev.endDate : endStr;
      let current = ev.startDate;
      while (current <= recurEndStr) {
        if (current >= todayStr) {
          pushRow(current, total, ev.eventName);
        }
        current = advanceIsoByFrequency(current, frequency);
      }
    }
  }

  if (toInsert.length > 0) {
    await db.insert(forecastedTransactionsTable).values(toInsert);
  }

  console.log(`Created ${toInsert.length} forecasted transactions.`);

  // Retirement settings live on the global user_settings row (userId = 1).
  const retirementValues = {
    currentAge: 42,
    retirementAge: 65,
    retirementGoal: "2000000",
    expectedReturnRate: "7",
    inflationRate: "3",
    monthlySpendingGoal: "8000",
    socialSecurityMonthly: "2200",
    retirementDurationYears: 25,
  };
  const existingSettings = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, userId)).limit(1);
  if (existingSettings.length > 0) {
    await db.update(userSettingsTable).set(retirementValues).where(eq(userSettingsTable.userId, userId));
  } else {
    await db.insert(userSettingsTable).values({
      userId,
      balanceAsOfDate: toLocalIso(today),
      ...retirementValues,
    });
  }
  console.log("Seeded retirement settings.");

  console.log("\nSeed complete! Open the dashboard to see your data.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
