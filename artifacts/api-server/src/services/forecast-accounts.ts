import { db, accountsTable } from "@workspace/db";
import { and, eq, ne, isNotNull } from "drizzle-orm";

/**
 * SINGLE SOURCE OF TRUTH for which accounts count toward the forecast.
 *
 * Every place that (a) ingests posted transactions into the ledger,
 * (b) anchors the start balance, or (c) reads posted activity for the cash
 * view MUST use this helper. If ingestion and balance ever disagree about
 * the account set, the running balance breaks in ways that are very hard
 * to diagnose — do not re-implement this filter locally.
 *
 * A forecast account is: Plaid-linked, not a credit card, and explicitly
 * opted in by the user (is_forecast_account). Credit cards are never
 * forecast accounts.
 */
export type ForecastAccount = typeof accountsTable.$inferSelect;

export interface ForecastAccountsResult {
  accounts: ForecastAccount[];
  /** The user has at least one Plaid-linked non-credit-card account. */
  hasLinkedCashAccounts: boolean;
  /**
   * True when the user linked cash accounts but selected none for the
   * forecast — the forecast has no balance basis. Callers must surface
   * this ("choose at least one account for your forecast"), never treat
   * it as a silent zero.
   */
  noneSelected: boolean;
}

export async function getForecastAccounts(userId: string): Promise<ForecastAccountsResult> {
  const linkedCash = await db
    .select()
    .from(accountsTable)
    .where(and(
      eq(accountsTable.userId, userId),
      isNotNull(accountsTable.plaidAccountId),
      ne(accountsTable.accountType, "credit_card"),
    ));
  const accounts = linkedCash.filter((a) => a.isForecastAccount);
  return {
    accounts,
    hasLinkedCashAccounts: linkedCash.length > 0,
    noneSelected: linkedCash.length > 0 && accounts.length === 0,
  };
}
