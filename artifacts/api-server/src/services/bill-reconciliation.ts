import {
  db,
  billsTable,
  accountsTable,
  plaidTransactionsTable,
  forecastedTransactionsTable,
  billMatchDismissalsTable,
  type Bill,
  type PlaidTransaction,
} from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import { merchantMatchStrength } from "./cycle-processing";

/**
 * P6 — planned-vs-actual reconciliation for BANK-PAID bills.
 *
 * For each planned (not-yet-actual) forecast row of a bill paid from a
 * connected bank/depository account, find a posted Plaid transaction on that
 * account that matches the P5.5 criteria:
 *   - match_merchant similarity (strong or fuzzy),
 *   - amount within ±15% of the planned amount,
 *   - date within ±7 days of the planned due date.
 * Card-paid bills reconcile through card_cycle_bills — they never appear here
 * (their forecast rows carry ccAccountId / sourceCardCycleId, both excluded).
 */
export interface ReconcileCandidate {
  forecastTransactionId: number;
  plaidTransactionId: number;
  billId: number;
  actualDate: string; // YYYY-MM-DD posted date
  actualAmount: number; // absolute outflow amount
  postedName: string; // merchant/name of the posted transaction
}

const AMOUNT_TOLERANCE = 0.15;
const DATE_WINDOW_DAYS = 7;

function dayDiff(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86_400_000;
}

/** Bills eligible for bank reconciliation: active, has a merchant pattern, and
 * paid from a NON-credit-card account that is Plaid-connected. */
async function eligibleBills(userId: string): Promise<Array<{ bill: Bill; plaidAccountId: string }>> {
  const rows = await db
    .select({ bill: billsTable, accountType: accountsTable.accountType, plaidAccountId: accountsTable.plaidAccountId })
    .from(billsTable)
    .innerJoin(accountsTable, eq(accountsTable.id, billsTable.paymentAccountId))
    .where(and(
      eq(billsTable.userId, userId),
      eq(billsTable.isActive, true),
      isNotNull(billsTable.matchMerchant),
      ne(accountsTable.accountType, "credit_card"),
      isNotNull(accountsTable.plaidAccountId),
    ));
  return rows.map((r) => ({ bill: r.bill, plaidAccountId: r.plaidAccountId! }));
}

export async function findReconcileCandidates(userId: string): Promise<ReconcileCandidate[]> {
  const eligible = await eligibleBills(userId);
  if (eligible.length === 0) return [];
  const billIds = eligible.map((e) => e.bill.id);
  const byBillId = new Map(eligible.map((e) => [e.bill.id, e]));

  // Planned rows for those bills: not yet actual/confirmed, not missed, and
  // not part of any card path (standalone bank-paid rows only).
  const plannedRows = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      inArray(forecastedTransactionsTable.sourceBillId, billIds),
      eq(forecastedTransactionsTable.isActual, false),
      isNull(forecastedTransactionsTable.sourceCardCycleId),
      isNull(forecastedTransactionsTable.ccAccountId),
      isNull(forecastedTransactionsTable.status),
    ));
  if (plannedRows.length === 0) return [];

  // Posted (non-pending) transactions on the bills' bank accounts. Outflows
  // only: Plaid amounts are positive for money leaving the account.
  const plaidAccountIds = [...new Set(eligible.map((e) => e.plaidAccountId))];
  const txns = await db
    .select()
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.userId, userId),
      inArray(plaidTransactionsTable.accountId, plaidAccountIds),
      eq(plaidTransactionsTable.pending, false),
    ));

  // Transactions already confirmed against some forecast row are spoken for.
  const linkedRows = await db
    .select({ matchedId: forecastedTransactionsTable.matchedPlaidTransactionId })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
    ));
  const usedTxnIds = new Set(linkedRows.map((r) => r.matchedId!));

  // Dismissed (bill, transaction) pairs are never re-suggested.
  const dismissals = await db
    .select()
    .from(billMatchDismissalsTable)
    .where(eq(billMatchDismissalsTable.userId, userId));
  const dismissedPairs = new Set(dismissals.map((d) => `${d.billId}|${d.plaidTransactionId}`));

  // Best candidate per planned row; each transaction offered to at most one
  // row. Rows sorted by date so the earliest occurrence claims a match first.
  const sorted = [...plannedRows].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id - b.id);
  const claimed = new Set<number>(usedTxnIds);
  const out: ReconcileCandidate[] = [];
  for (const row of sorted) {
    const entry = byBillId.get(row.sourceBillId!);
    if (!entry) continue;
    // Bank reconciliation applies to outflows; income-type bill rows are
    // handled by the paycheck confirm flow.
    if (row.transactionType !== "expense") continue;
    const planned = Math.abs(parseFloat(String(row.amount)));
    if (!(planned > 0)) continue;
    let best: { txn: PlaidTransaction; strong: boolean; amountDelta: number; dateDelta: number } | null = null;
    for (const txn of txns) {
      if (claimed.has(txn.id)) continue;
      if (txn.accountId !== entry.plaidAccountId) continue;
      if (dismissedPairs.has(`${entry.bill.id}|${txn.id}`)) continue;
      const actual = parseFloat(String(txn.amount));
      if (!(actual > 0)) continue; // outflows only
      if (Math.abs(actual - planned) > planned * AMOUNT_TOLERANCE) continue;
      if (dayDiff(txn.date, row.transactionDate) > DATE_WINDOW_DAYS) continue;
      const strength = merchantMatchStrength(entry.bill.matchMerchant!, txn);
      if (strength === "none") continue;
      // Rank: merchant strength first (strong beats fuzzy), then closest
      // amount, then closest date.
      const cand = {
        txn,
        strong: strength === "strong",
        amountDelta: Math.abs(actual - planned),
        dateDelta: dayDiff(txn.date, row.transactionDate),
      };
      if (
        !best ||
        (cand.strong && !best.strong) ||
        (cand.strong === best.strong &&
          (cand.amountDelta < best.amountDelta ||
            (cand.amountDelta === best.amountDelta && cand.dateDelta < best.dateDelta)))
      ) {
        best = cand;
      }
    }
    if (best) {
      claimed.add(best.txn.id);
      out.push({
        forecastTransactionId: row.id,
        plaidTransactionId: best.txn.id,
        billId: entry.bill.id,
        actualDate: best.txn.date,
        actualAmount: Math.abs(parseFloat(String(best.txn.amount))),
        postedName: best.txn.merchantName ?? best.txn.name ?? "Posted transaction",
      });
    }
  }
  return out;
}
