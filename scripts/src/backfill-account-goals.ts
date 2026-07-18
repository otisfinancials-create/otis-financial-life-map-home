import { db, accountsTable, accountGoalsTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";

async function main() {
  const accountsWithGoals = await db
    .select()
    .from(accountsTable)
    .where(isNotNull(accountsTable.savingsGoal));

  let inserted = 0;
  for (const account of accountsWithGoals) {
    const result = await db
      .insert(accountGoalsTable)
      .values({
        userId: account.userId,
        accountId: account.id,
        goalAmount: String(account.savingsGoal),
      })
      .onConflictDoNothing()
      .returning();
    if (result.length > 0) inserted += 1;
  }

  console.log(
    `Backfill complete: ${accountsWithGoals.length} accounts with legacy savings goals, ${inserted} new account_goals rows inserted (existing rows untouched).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
