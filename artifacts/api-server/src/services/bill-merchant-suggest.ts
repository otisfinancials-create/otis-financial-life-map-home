import { and, eq, gt, gte, isNull, isNotNull, inArray } from "drizzle-orm";
import { db, billsTable, accountsTable, plaidTransactionsTable } from "@workspace/db";
import { trigramSimilarity } from "./cycle-processing";

/**
 * P5.5 — one-time "link existing bills" pass: suggestion engine.
 *
 * For each active bill that has a payment_account_id but no match_merchant,
 * scan recent posted money-out charges on that account and rank candidate
 * merchants by amount proximity (±15%), recurrence (consistent day-of-month
 * cadence), name similarity to the bill, and recency. Returns the top 1–3
 * candidates WITH the sample charges that support each, so the user can
 * confirm with evidence. No candidate ⇒ the bill needs manual entry.
 *
 * This deliberately reuses the backfill's conventions (normalization, ±15%
 * amount window, consistent-day recurrence instead of due-day ±7 — real
 * charge dates routinely lag stored due days by weeks).
 */

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : parseFloat(v) || 0;

const STOP = new Set(["the", "and", "for", "inc", "llc", "co", "of", "a"]);
const toks = (s: string): string[] => norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t));

export interface BillLinkSample {
  date: string;
  amount: number;
  description: string;
}

export interface BillLinkCandidate {
  merchant: string; // normalized key to store as match_merchant
  displayName: string; // best raw name for display
  occurrences: number;
  samples: BillLinkSample[];
}

type Txn = typeof plaidTransactionsTable.$inferSelect;
type Bill = typeof billsTable.$inferSelect;

/**
 * Merchant-name plausibility between the bill and a candidate merchant.
 * Compares the bill's display name, company_url hostname, and any existing
 * match_merchant against the candidate. Returns 0 when there is NO
 * plausible name relationship — such candidates are dropped entirely, no
 * matter how well the amount fits.
 */
function nameAffinity(bill: Bill, merchant: string): number {
  const sources: string[] = [bill.billName];
  if (bill.matchMerchant) sources.push(bill.matchMerchant);
  if (bill.companyUrl) {
    // "https://www.appletv.com/x" -> "appletv"
    const host = bill.companyUrl.replace(/^[a-z]+:\/\//i, "").split("/")[0].replace(/^www\./i, "");
    const stem = host.split(".").slice(0, -1).join(" ") || host;
    if (stem) sources.push(stem);
  }

  const mTokens = toks(merchant);
  let best = 0;
  for (const src of sources) {
    const sTokens = toks(src);
    // Exact shared significant token: "apple tv" ~ "apple.com/bill".
    if (sTokens.some((t) => mTokens.includes(t))) best = Math.max(best, 1);
    // Substring containment between tokens (len >= 4): "appletv" ~ "apple".
    else if (
      sTokens.some((s) => mTokens.some((m) =>
        (s.length >= 4 && m.includes(s)) || (m.length >= 4 && s.includes(m))))
    ) best = Math.max(best, 0.9);
    // Whole-string trigram similarity: misspellings, spacing differences.
    else {
      const tri = trigramSimilarity(src, merchant);
      if (tri >= 0.5) best = Math.max(best, 0.6 + 0.4 * Math.min(1, (tri - 0.5) / 0.5));
    }
  }
  return best;
}

/**
 * Rank candidate merchants for one bill from its account's recent charges.
 * Merchant-name plausibility is the PRIMARY signal and a hard gate: a
 * candidate with no name relationship to the bill is never suggested,
 * regardless of amount fit ("Shell" is not "apple tv" just because both are
 * ~$13). Amount proximity and cadence only rank among plausible merchants.
 */
export function rankCandidates(bill: Bill, txns: Txn[]): BillLinkCandidate[] {
  const expected = num(bill.amount);
  if (expected <= 0) return [];

  // Amount proximity gate: ±15% of the bill's amount.
  const inWindow = txns.filter((t) => Math.abs(num(t.amount) - expected) / expected <= 0.15);
  if (inWindow.length === 0) return [];

  // Group by normalized merchant (merchant_name preferred, else name).
  const groups = new Map<string, Txn[]>();
  for (const t of inWindow) {
    const key = norm(t.merchantName) || norm(t.name);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  const today = Date.now();

  const scored = [...groups.entries()].map(([merchant, charges]) => {
    // HARD GATE: no plausible merchant-name relationship -> not a candidate.
    const nameScore = nameAffinity(bill, merchant);
    if (nameScore === 0) return null;

    charges.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

    // Amount proximity: 1 at exact, 0 at the 15% edge (best single charge).
    const amountScore = Math.max(
      ...charges.map((t) => 1 - Math.abs(num(t.amount) - expected) / (expected * 0.15)),
    );

    // Recurrence, frequency-aware: >=2 charges whose median gap matches the
    // bill's cadence (weekly ~7d, biweekly ~14d, monthly ~30d, quarterly
    // ~91d, annual ~365d) within ±40% scores 1; repeats on the wrong
    // cadence scores 0.4; a lone charge scores 0.
    let recurrenceScore = 0;
    if (charges.length >= 2) {
      const times = charges
        .map((t) => new Date(t.date + "T00:00:00Z").getTime())
        .sort((a, b) => a - b);
      const gaps = times.slice(1).map((t, i) => (t - times[i]) / 86_400_000).filter((g) => g > 0);
      const median = gaps.length
        ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
        : 0;
      const cadenceDays: Record<string, number> = {
        weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.3, annually: 365, yearly: 365,
      };
      const expectedGap = cadenceDays[(bill.frequency ?? "monthly").toLowerCase()] ?? 30.44;
      recurrenceScore =
        median > 0 && Math.abs(median - expectedGap) / expectedGap <= 0.4 ? 1 : 0.4;
    }

    // Recency: newest supporting charge, 1 at 0 days -> 0 at 180 days.
    const newestMs = new Date(charges[0].date + "T00:00:00Z").getTime();
    const recencyScore = Math.max(0, 1 - (today - newestMs) / (180 * 86_400_000));

    // Merchant plausibility dominates; amount and cadence only break ties
    // among plausible merchants.
    const score = nameScore * 0.55 + amountScore * 0.2 + recurrenceScore * 0.15 + recencyScore * 0.1;

    return {
      merchant,
      displayName: charges[0].merchantName || charges[0].name || merchant,
      occurrences: charges.length,
      samples: charges.slice(0, 3).map((t) => ({
        date: t.date,
        amount: num(t.amount),
        description: t.merchantName || t.name || merchant,
      })),
      score,
    };
  });

  // Candidates without a plausible merchant-name relationship were dropped
  // above — if nothing survives, the bill goes to manual entry instead of
  // being offered amount-only lookalikes.
  return scored
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _score, ...rest }) => rest);
}

/**
 * Suggestions for a bill-like shape that may not be saved yet (create form)
 * or whose fields are being edited. Loads the paying account's recent
 * charges and ranks them with the same merchant-name-first engine.
 */
export async function suggestForBillLike(
  userId: string,
  input: { billName: string; amount: number; frequency?: string | null; paymentAccountId: number; companyUrl?: string | null },
  lookbackDays = 180,
): Promise<BillLinkCandidate[]> {
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.id, input.paymentAccountId), eq(accountsTable.userId, userId)));
  if (!account?.plaidAccountId) return [];

  const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const txns = await db
    .select()
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.accountId, account.plaidAccountId),
      gt(plaidTransactionsTable.amount, "0"),
      eq(plaidTransactionsTable.pending, false),
      gte(plaidTransactionsTable.date, sinceIso),
    ));

  const pseudoBill = {
    billName: input.billName,
    amount: String(input.amount),
    frequency: input.frequency ?? "monthly",
    companyUrl: input.companyUrl ?? null,
    matchMerchant: null,
  } as Bill;
  return rankCandidates(pseudoBill, txns);
}

export interface BillLinkReviewItem {
  bill: Bill;
  accountName: string;
  candidates: BillLinkCandidate[];
}

/**
 * All of a user's active bills that have a paying account but no
 * match_merchant, each with ranked merchant suggestions.
 */
export async function listBillLinkReview(userId: string, lookbackDays = 180): Promise<BillLinkReviewItem[]> {
  const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const bills = await db
    .select()
    .from(billsTable)
    .where(and(
      eq(billsTable.userId, userId),
      eq(billsTable.isActive, true),
      isNotNull(billsTable.paymentAccountId),
      isNull(billsTable.matchMerchant),
    ))
    .orderBy(billsTable.billName);
  if (bills.length === 0) return [];

  const accountIds = [...new Set(bills.map((b) => b.paymentAccountId!))];
  const accounts = await db
    .select()
    .from(accountsTable)
    .where(and(eq(accountsTable.userId, userId), inArray(accountsTable.id, accountIds)));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const plaidIds = accounts.map((a) => a.plaidAccountId).filter((x): x is string => !!x);
  const txns = plaidIds.length
    ? await db
        .select()
        .from(plaidTransactionsTable)
        .where(and(
          inArray(plaidTransactionsTable.accountId, plaidIds),
          gt(plaidTransactionsTable.amount, "0"),
          eq(plaidTransactionsTable.pending, false),
          gte(plaidTransactionsTable.date, sinceIso),
        ))
    : [];
  const txnsByPlaidId = new Map<string, Txn[]>();
  for (const t of txns) {
    const g = txnsByPlaidId.get(t.accountId);
    if (g) g.push(t);
    else txnsByPlaidId.set(t.accountId, [t]);
  }

  return bills.map((bill) => {
    const account = accountById.get(bill.paymentAccountId!);
    const accountTxns = account?.plaidAccountId ? (txnsByPlaidId.get(account.plaidAccountId) ?? []) : [];
    return {
      bill,
      accountName: account?.accountName ?? "Unknown account",
      candidates: rankCandidates(bill, accountTxns),
    };
  });
}
