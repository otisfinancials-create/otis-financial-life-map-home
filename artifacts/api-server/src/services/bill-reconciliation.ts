import {
  db,
  billsTable,
  accountsTable,
  plaidTransactionsTable,
  forecastedTransactionsTable,
  billMatchDismissalsTable,
  paySchedulesTable,
  type Bill,
  type PlaidTransaction,
} from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import { merchantMatchStrength } from "./cycle-processing";

/**
 * P6/P7 — planned-vs-actual reconciliation for BANK-PAID bills and paychecks.
 *
 * For each planned (not-yet-actual) forecast row, find posted Plaid
 * transactions that match:
 *   - FIXED bills: merchant + account + amount (±15%) + date (±7 days)
 *   - VARIABLE bills (bills.is_variable): merchant + account + date (±7 days)
 *     — amount is IGNORED (electric etc. vary by design)
 *   - INCOME (pay-schedule rows): employer name + deposit + date (±7 days)
 *     — amount is IGNORED (hours/bonuses vary)
 * When more than one transaction qualifies for a row, ALL candidates are
 * returned so the user chooses — never auto-picked. The user always sees the
 * posted amount + date before confirming.
 *
 * Card-paid bills reconcile through card_cycle_bills — they never appear here
 * (their forecast rows carry ccAccountId / sourceCardCycleId, both excluded).
 */
export interface ReconcileCandidateTxn {
  plaidTransactionId: number;
  actualDate: string; // YYYY-MM-DD posted date
  actualAmount: number; // absolute amount
  postedName: string; // merchant/name of the posted transaction
  pending: boolean; // still pending at the bank; amount/date may settle differently
}

export interface ReconcileSuggestion {
  forecastTransactionId: number;
  billId: number | null;
  payScheduleId: number | null;
  plannedAmount: number;
  plannedDate: string;
  /** Ranked best-first; length > 1 means ambiguous — the user must choose. */
  candidates: ReconcileCandidateTxn[];
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

export async function findReconcileSuggestions(userId: string): Promise<ReconcileSuggestion[]> {
  const eligible = await eligibleBills(userId);
  const billIds = eligible.map((e) => e.bill.id);
  const byBillId = new Map(eligible.map((e) => [e.bill.id, e]));

  const paySchedules = await db
    .select()
    .from(paySchedulesTable)
    .where(eq(paySchedulesTable.userId, userId));
  const payById = new Map(paySchedules.map((p) => [p.id, p]));

  if (billIds.length === 0 && paySchedules.length === 0) return [];

  // Planned rows: not yet actual/confirmed, not missed/removed, and not part
  // of any card path (standalone bank-paid rows only).
  const plannedRows = await db
    .select()
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.isActual, false),
      isNull(forecastedTransactionsTable.sourceCardCycleId),
      isNull(forecastedTransactionsTable.ccAccountId),
      isNull(forecastedTransactionsTable.status),
    ));
  const relevantRows = plannedRows.filter((r) =>
    (r.sourceBillId != null && byBillId.has(r.sourceBillId)) ||
    (r.sourcePayId != null && payById.has(r.sourcePayId)),
  );
  if (relevantRows.length === 0) return [];

  // Posted (non-pending) transactions on the user's NON-card bank accounts.
  const bankAccounts = await db
    .select({ plaidAccountId: accountsTable.plaidAccountId })
    .from(accountsTable)
    .where(and(
      eq(accountsTable.userId, userId),
      ne(accountsTable.accountType, "credit_card"),
      isNotNull(accountsTable.plaidAccountId),
    ));
  const bankAccountIds = bankAccounts.map((a) => a.plaidAccountId!);
  if (bankAccountIds.length === 0) return [];
  // Pending transactions ARE candidates (the user sees real bank activity as
  // soon as it appears); the sync remaps the reconciliation link when a
  // pending transaction settles under a new Plaid id.
  const txns = await db
    .select()
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.userId, userId),
      inArray(plaidTransactionsTable.accountId, bankAccountIds),
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

  // Dismissed (bill|pay, transaction) pairs are never re-suggested.
  const dismissals = await db
    .select()
    .from(billMatchDismissalsTable)
    .where(eq(billMatchDismissalsTable.userId, userId));
  const dismissedPairs = new Set(dismissals.map((d) =>
    d.billId != null ? `b${d.billId}|${d.plaidTransactionId}` : `p${d.payScheduleId}|${d.plaidTransactionId}`,
  ));

  type Ranked = { txn: PlaidTransaction; strong: boolean; amountDelta: number; dateDelta: number };
  const rank = (a: Ranked, b: Ranked): number =>
    (b.strong ? 1 : 0) - (a.strong ? 1 : 0) || a.amountDelta - b.amountDelta || a.dateDelta - b.dateDelta;

  // A transaction that is the TOP candidate for an earlier-dated row is
  // claimed by it (not offered as top to later rows), but remains listed as an
  // alternate; the confirm endpoint re-validates against live candidates.
  const sorted = [...relevantRows].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id - b.id);
  const claimed = new Set<number>(usedTxnIds);
  const out: ReconcileSuggestion[] = [];
  for (const row of sorted) {
    const planned = Math.abs(parseFloat(String(row.amount)));
    let ranked: Ranked[] = [];

    if (row.sourceBillId != null && row.transactionType === "expense") {
      const entry = byBillId.get(row.sourceBillId)!;
      if (!(planned > 0) && !entry.bill.isVariable) continue;
      for (const txn of txns) {
        if (claimed.has(txn.id)) continue;
        if (txn.accountId !== entry.plaidAccountId) continue;
        if (dismissedPairs.has(`b${entry.bill.id}|${txn.id}`)) continue;
        const actual = parseFloat(String(txn.amount));
        if (!(actual > 0)) continue; // outflows only
        // Variable bills ignore amount entirely; fixed bills need ±15%.
        if (!entry.bill.isVariable && Math.abs(actual - planned) > planned * AMOUNT_TOLERANCE) continue;
        if (dayDiff(txn.date, row.transactionDate) > DATE_WINDOW_DAYS) continue;
        const strength = merchantMatchStrength(entry.bill.matchMerchant!, txn);
        if (strength === "none") continue;
        ranked.push({
          txn,
          strong: strength === "strong",
          amountDelta: Math.abs(actual - planned),
          dateDelta: dayDiff(txn.date, row.transactionDate),
        });
      }
    } else if (row.sourcePayId != null && row.transactionType === "income") {
      const pay = payById.get(row.sourcePayId)!;
      const employer = pay.employerName.toLowerCase();
      for (const txn of txns) {
        if (claimed.has(txn.id)) continue;
        if (dismissedPairs.has(`p${pay.id}|${txn.id}`)) continue;
        const deposit = -parseFloat(String(txn.amount)); // Plaid: negative = inflow
        if (!(deposit > 0)) continue;
        const label = `${txn.merchantName ?? ""} ${txn.name ?? ""}`.toLowerCase();
        const txnName = (txn.merchantName ?? txn.name ?? "").toLowerCase();
        if (!label.includes(employer) && !(txnName && employer.includes(txnName))) continue;
        // Amount is IGNORED for income (varies by hours/bonuses).
        if (dayDiff(txn.date, row.transactionDate) > DATE_WINDOW_DAYS) continue;
        ranked.push({
          txn,
          strong: true,
          amountDelta: Math.abs(deposit - planned),
          dateDelta: dayDiff(txn.date, row.transactionDate),
        });
      }
    } else {
      continue;
    }

    if (ranked.length === 0) continue;
    ranked = ranked.sort(rank);
    claimed.add(ranked[0].txn.id);
    out.push({
      forecastTransactionId: row.id,
      billId: row.sourceBillId,
      payScheduleId: row.sourcePayId,
      plannedAmount: planned,
      plannedDate: row.transactionDate,
      candidates: ranked.map((c) => ({
        plaidTransactionId: c.txn.id,
        actualDate: c.txn.date,
        actualAmount: Math.abs(parseFloat(String(c.txn.amount))),
        postedName: c.txn.merchantName ?? c.txn.name ?? "Posted transaction",
        pending: c.txn.pending,
      })),
    });
  }
  return out;
}
