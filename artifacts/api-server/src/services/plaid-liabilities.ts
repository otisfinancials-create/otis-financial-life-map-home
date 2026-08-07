import { and, eq, isNull } from "drizzle-orm";
import { db, accountsTable, type PlaidItem } from "@workspace/db";
import { plaidClient } from "../lib/plaid";
import { generateCyclesForAccount } from "./card-cycles";
import { sanitizeSyncError } from "./plaid-sync";
import { logger } from "../lib/logger";

/** Plaid error codes that mean "no liabilities here" — expected, never fatal. */
const BENIGN_LIABILITIES_ERRORS = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "PRODUCT_NOT_READY",
  "NO_LIABILITY_ACCOUNTS",
  "NO_ACCOUNTS",
]);

export interface LiabilitiesSyncResult {
  updated: number;
  autoConfigured: number[]; // account ids whose statement/due days were filled
  supported: boolean;
  /** Fixed-payment-mode card whose last_statement_balance changed this sync —
   * the fixed spread in the forecast is anchored to that balance, so the
   * caller should regenerate the user's forecast to re-anchor the schedule. */
  fixedModeStatementChanged: boolean;
}

/** Day-of-month from a YYYY-MM-DD string, clamped to 1-31. */
function dayOf(iso: string): number {
  const d = Number(iso.slice(8, 10));
  return Math.min(Math.max(d, 1), 31);
}

/**
 * Fetch /liabilities/get for an item and store credit-card liability data
 * (minimum payment, statement balance, next due date, purchase APR) on the
 * matching accounts rows.
 *
 * Auto-configuration: when a card has NO statement_day AND NO due_day (the
 * user never configured it), fill statement_day from the day-of-month of
 * last_statement_issue_date and due_day from next_payment_due_date, then
 * generate its card cycles. Manual configuration is never overwritten —
 * accounts with either day already set only receive the liability fields.
 *
 * Best-effort by contract: institutions that don't support Liabilities
 * return PRODUCTS_NOT_SUPPORTED / NO_LIABILITY_ACCOUNTS; those (and any
 * other failure) must never fail the caller (link, update-mode, or sync).
 * Callers therefore don't need their own try/catch.
 */
export async function syncLiabilitiesForItem(
  item: Pick<PlaidItem, "id" | "userId" | "accessToken">,
): Promise<LiabilitiesSyncResult> {
  const result: LiabilitiesSyncResult = { updated: 0, autoConfigured: [], supported: true, fixedModeStatementChanged: false };
  let credits;
  try {
    const response = await plaidClient.liabilitiesGet({ access_token: item.accessToken });
    credits = response.data.liabilities.credit ?? [];
  } catch (err) {
    const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
    if (code && BENIGN_LIABILITIES_ERRORS.has(code)) {
      logger.info({ itemId: item.id, code }, "liabilities not available for item");
      result.supported = false;
      return result;
    }
    logger.warn({ itemId: item.id, err: sanitizeSyncError(err) }, "liabilities fetch failed (non-fatal)");
    result.supported = false;
    return result;
  }

  const now = new Date();
  for (const credit of credits) {
    if (!credit.account_id) continue;
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(and(
        eq(accountsTable.userId, item.userId),
        eq(accountsTable.plaidAccountId, credit.account_id),
      ));
    if (!account) continue;

    // Purchase APR when present, else the first APR Plaid reports.
    const apr =
      credit.aprs?.find((a) => a.apr_type === "purchase_apr")?.apr_percentage ??
      credit.aprs?.[0]?.apr_percentage ??
      null;
    // Full aprs[] as reported — a 'special' entry (often 0%) with a
    // balance_subject_to_apr signals promotional financing.
    const aprs = (credit.aprs ?? []).map((a) => ({
      aprType: a.apr_type,
      aprPercentage: a.apr_percentage ?? null,
      balanceSubjectToApr: a.balance_subject_to_apr ?? null,
      interestChargeAmount: a.interest_charge_amount ?? null,
    }));

    // Statement-balance change detection (compare as numbers — the column is
    // numeric text). A changed balance on a fixed-payment-mode card means the
    // amortization anchor moved (user paid extra, or a new statement closed).
    const prevStmt = account.lastStatementBalance != null ? parseFloat(String(account.lastStatementBalance)) : null;
    const nextStmt = credit.last_statement_balance ?? null;
    const stmtChanged = (prevStmt ?? null) !== (nextStmt ?? null) &&
      !(prevStmt != null && nextStmt != null && Math.abs(prevStmt - nextStmt) < 0.005);

    try {
      await db
        .update(accountsTable)
        .set({
          minimumPayment: credit.minimum_payment_amount != null ? String(credit.minimum_payment_amount) : null,
          lastStatementBalance: credit.last_statement_balance != null ? String(credit.last_statement_balance) : null,
          nextPaymentDueDate: credit.next_payment_due_date ?? null,
          purchaseApr: apr != null ? String(apr) : null,
          aprs,
          lastPaymentAmount: credit.last_payment_amount != null ? String(credit.last_payment_amount) : null,
          liabilitiesSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(accountsTable.id, account.id));
      result.updated++;
      if (stmtChanged && account.paymentMode === "fixed") {
        result.fixedModeStatementChanged = true;
      }

      // Auto-configure cycle days ONLY when the user never set either day.
      // The isNull guards in the WHERE make this race-safe against a
      // concurrent manual configuration: if the user saved days between our
      // read and this write, the update matches zero rows.
      if (
        account.statementDay == null &&
        account.dueDay == null &&
        credit.last_statement_issue_date &&
        credit.next_payment_due_date
      ) {
        const updated = await db
          .update(accountsTable)
          .set({
            statementDay: dayOf(credit.last_statement_issue_date),
            dueDay: dayOf(credit.next_payment_due_date),
            updatedAt: now,
          })
          .where(and(
            eq(accountsTable.id, account.id),
            isNull(accountsTable.statementDay),
            isNull(accountsTable.dueDay),
          ))
          .returning({ id: accountsTable.id });
        if (updated.length > 0) {
          // Safe on existing cycles: generateCyclesForAccount has REPLACE
          // semantics keyed by statement period (updates in place, dedupes).
          await generateCyclesForAccount(account.id);
          result.autoConfigured.push(account.id);
        }
      }
    } catch (err) {
      logger.warn({ itemId: item.id, accountId: account.id, err: sanitizeSyncError(err) }, "liabilities account update failed (non-fatal)");
    }
  }
  return result;
}
