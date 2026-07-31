import {
  db,
  accountsTable,
  userSettingsTable,
  paySchedulesTable,
  plaidTransactionsTable,
  forecastedTransactionsTable,
} from "@workspace/db";
import { and, eq, gte, lt, inArray, isNull, isNotNull, or } from "drizzle-orm";
import { findReconcileSuggestions } from "./bill-reconciliation";
import { getForecastAccounts } from "./forecast-accounts";
import { logger } from "../lib/logger";

/**
 * P6 part 2 — roll posted actuals into the forecast past.
 *
 * From the user's forecast start date to today, the ledger's PAST must
 * reflect ACTUALS so the running balance is anchored to reality:
 *
 *  1. Stale planned rows (past-due beyond a grace window, never confirmed)
 *     are resolved: auto-reconciled when a matching posted transaction
 *     exists, otherwise marked "missed" so they stop silently stepping the
 *     balance as-if-paid.
 *  2. Posted BANK transactions not matched to any planned bill/paycheck are
 *     rolled in as derived "unplanned" actual rows, bucketed by
 *     day + category. They step the running balance.
 *
 * Conservation: every posted bank transaction affects the balance exactly
 * once — via a reconciled planned row OR an unplanned bucket, never both,
 * never zero. Card charges are excluded entirely (card spending hits the
 * balance only through the card's due-date payment). Posted bank-side
 * credit-card payments reconcile onto a matching planned cycle/group parent
 * when one exists (planned → actual), otherwise they materialize as
 * standalone actual rows — either way the cash event counts exactly once.
 */

const GRACE_DAYS = 3; // planned rows stay "pending" this long past their date

function localIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return localIso(new Date(y, m - 1, d + days));
}
function dayDiff(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86_400_000;
}
const titleCase = (s: string) =>
  s.toLowerCase().split("_").map((w) => (w === "and" ? "&" : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

function isCardPaymentTxn(t: { personalFinanceCategory: string | null; personalFinanceCategoryDetailed: string | null }): boolean {
  const detailed = t.personalFinanceCategoryDetailed ?? "";
  return detailed.includes("CREDIT_CARD_PAYMENT") || (t.personalFinanceCategory === "LOAN_PAYMENTS" && detailed.includes("CREDIT_CARD"));
}

// Transfer classification: these detailed categories are ASSET MOVEMENT —
// money moving between the user's own accounts, not spending. Everything
// else under TRANSFER_* (Zelle/Venmo app transfers, withdrawals, deposits,
// other inflows) is real money movement and keeps its current treatment.
// Card payments are already special-cased above and are checked FIRST.
const ASSET_MOVEMENT_DETAILED = new Set([
  "TRANSFER_OUT_ACCOUNT_TRANSFER",
  "TRANSFER_IN_ACCOUNT_TRANSFER",
  "TRANSFER_OUT_SAVINGS",
  "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
]);

/** Plain-language "money moved" label for an asset-movement transaction. */
function assetMovementLabel(detailed: string | null): string {
  switch (detailed) {
    case "TRANSFER_OUT_SAVINGS":
      return "Transfer to savings";
    case "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS":
      return "Transfer to investments";
    case "TRANSFER_OUT_ACCOUNT_TRANSFER":
      return "Transfer to another account";
    case "TRANSFER_IN_ACCOUNT_TRANSFER":
      return "Transfer from another account";
    default:
      return "Money moved";
  }
}

function isAssetMovementTxn(t: { personalFinanceCategory: string | null; personalFinanceCategoryDetailed: string | null }): boolean {
  if (isCardPaymentTxn(t)) return false;
  return ASSET_MOVEMENT_DETAILED.has(t.personalFinanceCategoryDetailed ?? "");
}

export interface RollResult {
  autoReconciled: number;
  paychecksConfirmed: number;
  markedMissed: number;
  unplannedRows: number;
  cardPaymentsReconciled: number;
  cardPaymentsMaterialized: number;
}

// Per-user serialization: regen, plaid sync, and reconcile routes can all
// trigger a roll concurrently. Overlapping delete-and-reinsert of the
// unplanned buckets (or double auto-reconciles) would transiently corrupt the
// ledger, so each user's rolls run one at a time; a call arriving while one is
// in flight simply chains after it (re-deriving from the then-current state).
const rollChains = new Map<string, Promise<RollResult>>();

export function rollActualsForUser(userId: string): Promise<RollResult> {
  const prev = rollChains.get(userId) ?? Promise.resolve(null as unknown as RollResult);
  const next = prev.catch(() => undefined).then(() => rollActualsForUserInner(userId));
  rollChains.set(userId, next);
  next.finally(() => {
    if (rollChains.get(userId) === next) rollChains.delete(userId);
  }).catch(() => undefined);
  return next;
}

async function rollActualsForUserInner(userId: string): Promise<RollResult> {
  const result: RollResult = { autoReconciled: 0, paychecksConfirmed: 0, markedMissed: 0, unplannedRows: 0, cardPaymentsReconciled: 0, cardPaymentsMaterialized: 0 };
  const [settings] = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, userId));
  const startDate = settings?.forecastStartDate ?? null;
  if (!startDate) return result; // feature dormant until the user anchors a start date

  const todayStr = localIso();
  const graceCutoff = addDaysIso(todayStr, -GRACE_DAYS);

  // ── 1a. Auto-reconcile stale BANK-PAID BILL and PAYCHECK rows ──
  // (same candidate criteria as the manual Reconcile chip). Only rows with
  // exactly ONE candidate auto-confirm — an ambiguous match (several
  // qualifying transactions, common for variable bills/income where amount
  // carries no signal) is always left for the user to choose.
  let suggestions = await findReconcileSuggestions(userId);
  for (const sug of suggestions) {
    if (sug.candidates.length !== 1) continue;
    const cand = sug.candidates[0];
    if (cand.pending) continue; // pending amounts/dates can settle differently — user-confirm only
    const [row] = await db
      .select()
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.id, sug.forecastTransactionId),
        eq(forecastedTransactionsTable.userId, userId),
      ));
    if (!row || row.isActual || row.transactionDate >= graceCutoff) continue; // only stale rows auto-confirm
    await db
      .update(forecastedTransactionsTable)
      .set({
        transactionDate: cand.actualDate,
        amount: String(cand.actualAmount),
        forecastedDate: row.transactionDate,
        forecastedAmount: row.amount,
        isActual: true,
        isCommitted: true,
        status: null,
        matchedPlaidTransactionId: cand.plaidTransactionId,
      })
      .where(eq(forecastedTransactionsTable.id, row.id));
    if (row.sourcePayId != null) result.paychecksConfirmed++;
    else result.autoReconciled++;
  }

  // ── Load forecast accounts + posted window transactions ──
  // SINGLE SOURCE OF TRUTH: the account set that gets ingested here MUST be
  // the same set the anchor/balance uses — see services/forecast-accounts.ts.
  const forecastAccounts = await getForecastAccounts(userId);
  if (forecastAccounts.noneSelected) {
    // No balance basis: linked cash accounts exist but none are selected for
    // the forecast. The user-facing guard lives in the anchor route; here we
    // must not ingest from an undefined pool — log loudly and skip ingestion.
    logger.warn({ userId }, "Actuals roll skipped ingestion: user has linked cash accounts but none selected for forecast");
  }
  const bankIds = forecastAccounts.accounts.map((a) => a.plaidAccountId!);

  const txns = bankIds.length
    ? await db
        .select()
        .from(plaidTransactionsTable)
        .where(and(
          eq(plaidTransactionsTable.userId, userId),
          inArray(plaidTransactionsTable.accountId, bankIds),
          eq(plaidTransactionsTable.pending, false),
          gte(plaidTransactionsTable.date, startDate),
          lt(plaidTransactionsTable.date, todayStr),
        ))
    : [];

  // (Paycheck deposits are handled by the unified suggestion service above —
  // stale single-candidate pay rows auto-confirm in 1a, and every live
  // candidate deposit is excluded from the unplanned buckets in phase 2.)

  // Unplanned rows are excluded: they are rebuilt from scratch below, so
  // their links must not mask the very transactions they were derived from.
  const linkedRows = await db
    .select({ matchedId: forecastedTransactionsTable.matchedPlaidTransactionId })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      eq(forecastedTransactionsTable.isUnplanned, false),
    ));
  const claimedTxnIds = new Set(linkedRows.map((r) => r.matchedId!));

  // ── 1c. Reconcile posted bank-side card payments with planned CC parents ──
  // A payment FROM the bank TO a card is a real cash outflow. When a planned
  // cycle/group parent corresponds to it (close date + amount), reconcile the
  // parent onto the posted transaction (planned → actual) so the payment
  // counts exactly once. Unmatched payments materialize as standalone actual
  // rows in phase 2 (past payments that predate cycle generation, e.g. before
  // the card's cycles were configured, have no parent at all).
  const CARD_PAY_WINDOW = 7; // days between posted date and planned due date
  const CARD_PAY_TOLERANCE = 0.3; // projected statement totals are estimates
  const cardPayTxns = txns.filter((t) => isCardPaymentTxn(t) && !claimedTxnIds.has(t.id));
  if (cardPayTxns.length) {
    const plannedParents = await db
      .select()
      .from(forecastedTransactionsTable)
      .where(and(
        eq(forecastedTransactionsTable.userId, userId),
        eq(forecastedTransactionsTable.isCcParent, true),
        eq(forecastedTransactionsTable.isActual, false),
        isNull(forecastedTransactionsTable.status),
      ));
    // Card names/institutions disambiguate when several parents are close in
    // date+amount (e.g. two cards paid the same day): a parent whose card
    // name appears in the transaction label wins over one that doesn't.
    const ccAccountRows = await db
      .select({ id: accountsTable.id, accountName: accountsTable.accountName, institutionName: accountsTable.institutionName })
      .from(accountsTable)
      .where(and(eq(accountsTable.userId, userId), eq(accountsTable.accountType, "credit_card")));
    const cardTokens = new Map<number, string[]>(ccAccountRows.map((a) => [
      a.id,
      `${a.accountName} ${a.institutionName ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
    ]));
    const labelMatches = (accountId: number | null, label: string): boolean =>
      accountId != null && (cardTokens.get(accountId) ?? []).some((tok) => label.includes(tok));

    const usedParents = new Set<number>();
    for (const t of cardPayTxns) {
      const paid = parseFloat(String(t.amount)); // positive = bank outflow
      if (!(paid > 0)) continue;
      const label = `${t.merchantName ?? ""} ${t.name ?? ""}`.toLowerCase();
      let best: typeof plannedParents[number] | null = null;
      let bestScore = -Infinity;
      for (const row of plannedParents) {
        if (usedParents.has(row.id)) continue;
        const dDiff = dayDiff(t.date, row.transactionDate);
        if (dDiff > CARD_PAY_WINDOW) continue;
        const planned = Math.abs(parseFloat(String(row.amount)));
        const aDiff = Math.abs(planned - paid);
        if (aDiff > Math.max(paid * CARD_PAY_TOLERANCE, 25)) continue;
        // Name match dominates; then closest amount; then closest date.
        const score = (labelMatches(row.ccAccountId, label) ? 1_000_000 : 0) - aDiff * 100 - dDiff;
        if (score > bestScore) { best = row; bestScore = score; }
      }
      if (!best) continue;
      await db
        .update(forecastedTransactionsTable)
        .set({
          transactionDate: t.date,
          amount: String(Math.round(paid * 100) / 100),
          forecastedDate: best.transactionDate,
          forecastedAmount: best.amount,
          isActual: true,
          isCommitted: true,
          status: null,
          ...(best.sourceCardCycleId != null && { ccBasis: "actual" as const }),
          matchedPlaidTransactionId: t.id,
        })
        .where(eq(forecastedTransactionsTable.id, best.id));
      usedParents.add(best.id);
      claimedTxnIds.add(t.id);
      result.cardPaymentsReconciled++;
    }
  }

  // ── 1d. Mark remaining stale planned rows as missed ──
  const missed = await db
    .update(forecastedTransactionsTable)
    .set({ status: "missed" })
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.isActual, false),
      isNull(forecastedTransactionsTable.status),
      isNull(forecastedTransactionsTable.sourceCardCycleId),
      isNull(forecastedTransactionsTable.ccAccountId),
      isNull(forecastedTransactionsTable.sourceBalanceSyncId),
      eq(forecastedTransactionsTable.isUnplanned, false),
      lt(forecastedTransactionsTable.transactionDate, graceCutoff),
      gte(forecastedTransactionsTable.transactionDate, startDate),
      or(
        isNotNull(forecastedTransactionsTable.sourceBillId),
        isNotNull(forecastedTransactionsTable.sourcePayId),
        isNotNull(forecastedTransactionsTable.sourceLifeEventId),
      ),
    ))
    .returning({ id: forecastedTransactionsTable.id });
  result.markedMissed = missed.length;

  // ── 2. Rebuild the unplanned actual buckets ──
  // Re-derive candidates AFTER resolution: any transaction that is still a
  // live Confirm suggestion is excluded (its planned row steps the balance
  // until the user decides), keeping every posted transaction counted once.
  suggestions = await findReconcileSuggestions(userId);
  const excluded = new Set<number>(claimedTxnIds);
  for (const s of suggestions) for (const c of s.candidates) excluded.add(c.plaidTransactionId);
  // Refresh linked ids (auto-reconciles above added links). Unplanned rows'
  // links are ignored — those rows are deleted and rebuilt just below.
  const linkedNow = await db
    .select({ matchedId: forecastedTransactionsTable.matchedPlaidTransactionId })
    .from(forecastedTransactionsTable)
    .where(and(
      eq(forecastedTransactionsTable.userId, userId),
      isNotNull(forecastedTransactionsTable.matchedPlaidTransactionId),
      eq(forecastedTransactionsTable.isUnplanned, false),
    ));
  for (const r of linkedNow) excluded.add(r.matchedId!);

  // ── Transfer classification (asset movement) ──
  // 4a. INTERNAL PAIR: an asset-movement row with a counterpart on a
  // DIFFERENT forecast account, opposite sign, matching amount (±$0.01),
  // within ±3 days → both legs are internal to the forecast pool and are
  // excluded from the ledger entirely (net effect on balance: zero — the
  // money never left the pool).
  // 4b. Everything else stays in the ledger with today's amount and sign
  // (the cash genuinely left/entered the pool) but is labeled asset
  // movement, not spending.
  const INTERNAL_PAIR_DAYS = 3;
  const INTERNAL_PAIR_TOLERANCE = 0.01;
  const assetMoves = txns.filter((t) => !excluded.has(t.id) && isAssetMovementTxn(t));
  const internalPairIds = new Set<number>();
  for (let i = 0; i < assetMoves.length; i++) {
    const a = assetMoves[i];
    if (internalPairIds.has(a.id)) continue;
    for (let j = i + 1; j < assetMoves.length; j++) {
      const b = assetMoves[j];
      if (internalPairIds.has(b.id)) continue;
      if (a.accountId === b.accountId) continue; // must be two different forecast accounts
      const amtA = parseFloat(String(a.amount));
      const amtB = parseFloat(String(b.amount));
      if (Math.sign(amtA) === Math.sign(amtB)) continue; // opposite legs only
      if (Math.abs(Math.abs(amtA) - Math.abs(amtB)) > INTERNAL_PAIR_TOLERANCE) continue;
      if (dayDiff(a.date, b.date) > INTERNAL_PAIR_DAYS) continue;
      internalPairIds.add(a.id);
      internalPairIds.add(b.id);
      break;
    }
  }

  type Bucket = { date: string; label: string; type: "expense" | "income"; total: number; assetMovement?: boolean };
  const buckets = new Map<string, Bucket>();
  type UnplannedInsert = typeof forecastedTransactionsTable.$inferInsert;
  const cardPayRows: UnplannedInsert[] = [];
  for (const t of txns) {
    if (excluded.has(t.id)) continue;
    if (internalPairIds.has(t.id)) continue; // both legs inside the pool — not a cash event
    // Bank-side card payments not reconciled to a planned parent above are
    // real cash outflows with no other representation (e.g. they posted
    // before the card's cycles existed) — materialize each as its own
    // actual row so the balance steps exactly once.
    if (isCardPaymentTxn(t)) {
      const amt = parseFloat(String(t.amount)); // positive = outflow
      if (amt === 0) continue;
      const label = (t.merchantName ?? t.name ?? "Credit card").trim();
      cardPayRows.push({
        userId,
        transactionDate: t.date,
        description: `Card payment — ${label.length > 60 ? label.slice(0, 57) + "…" : label}`,
        amount: String(Math.round(Math.abs(amt) * 100) / 100),
        transactionType: amt > 0 ? "expense" : "income",
        category: "debt_payments",
        isActual: true,
        isCommitted: false,
        isUnplanned: true,
        matchedPlaidTransactionId: t.id,
        sortOrder: 0,
      });
      continue;
    }
    const amt = parseFloat(String(t.amount)); // positive = outflow
    if (isAssetMovementTxn(t)) {
      // 4b: crosses the pool boundary — steps the balance exactly as today,
      // same amount and sign, but classified as asset movement (not spend).
      // Bucketed per day + detailed category so the ledger reads as "money
      // moved" ("Transfer to savings"), never as generic unplanned spending.
      if (amt === 0) continue;
      const type = amt > 0 ? ("expense" as const) : ("income" as const);
      const label = assetMovementLabel(t.personalFinanceCategoryDetailed);
      const key = `${t.date}|asset-movement|${label}|${type}`;
      const b = buckets.get(key) ?? { date: t.date, label, type, total: 0, assetMovement: true };
      b.total += Math.abs(amt);
      buckets.set(key, b);
      continue;
    }
    if (amt > 0) {
      const label = titleCase(t.personalFinanceCategory ?? "OTHER");
      const key = `${t.date}|expense|${label}`;
      const b = buckets.get(key) ?? { date: t.date, label, type: "expense" as const, total: 0 };
      b.total += amt;
      buckets.set(key, b);
    } else if (amt < 0) {
      const key = `${t.date}|income`;
      const b = buckets.get(key) ?? { date: t.date, label: "Unplanned income", type: "income" as const, total: 0 };
      b.total += -amt;
      buckets.set(key, b);
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(forecastedTransactionsTable).where(and(
      eq(forecastedTransactionsTable.userId, userId),
      eq(forecastedTransactionsTable.isUnplanned, true),
    ));
    const rows = [...buckets.values()].map((b) => ({
      userId,
      transactionDate: b.date,
      description: b.label,
      amount: String(Math.round(b.total * 100) / 100),
      transactionType: b.type,
      category: b.assetMovement ? "Asset Movement" : b.type === "income" ? "Income" : "Other",
      isActual: true,
      isCommitted: false,
      isUnplanned: true,
      isAssetMovement: b.assetMovement === true,
      sortOrder: 0,
    }));
    const allRows = [...rows, ...cardPayRows];
    if (allRows.length > 0) await tx.insert(forecastedTransactionsTable).values(allRows);
    result.unplannedRows = rows.length;
    result.cardPaymentsMaterialized = cardPayRows.length;
  });

  logger.info({ userId, ...result }, "Rolled posted actuals into forecast past");
  return result;
}
