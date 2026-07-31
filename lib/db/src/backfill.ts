/**
 * Idempotent data backfills that must accompany schema pushes (this repo uses
 * drizzle-kit push, not migration files). Run after every `pnpm --filter db push`
 * — post-merge.sh does this automatically. Every statement here MUST be safe
 * to re-run any number of times.
 */
import { db } from "./index";
import { sql } from "drizzle-orm";

async function main() {
  // Forecast account boundary (2026-07): behavior-preserving backfill — the
  // forecast previously used all Plaid-linked non-credit-card accounts, so
  // existing linked cash accounts opt in; credit cards can never be true.
  // Guard: only rows still at the column default AND never touched by the
  // selection UI are affected; re-running never overrides a user's choice
  // because it only ever sets true where the legacy behavior requires it.
  await db.execute(sql`
    UPDATE accounts
    SET is_forecast_account = true
    WHERE plaid_account_id IS NOT NULL
      AND account_type != 'credit_card'
      AND is_forecast_account = false
      AND updated_at < '2026-07-31'
  `);
  console.log("Backfills applied.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
