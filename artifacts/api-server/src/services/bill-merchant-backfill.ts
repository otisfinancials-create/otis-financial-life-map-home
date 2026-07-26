import { and, eq, gt, gte, isNull, isNotNull } from "drizzle-orm";
import { db, billsTable, accountsTable, plaidTransactionsTable } from "@workspace/db";
import { trigramSimilarity } from "./cycle-processing";

/**
 * P5.5 Step 3 — best-effort backfill of bills.match_merchant.
 *
 * For every active bill that has a payment_account_id but no match_merchant,
 * look at recent posted charges on that account that plausibly match the bill
 * (amount within ±15%, dated within ±7 days of a due-day occurrence). If the
 * candidates point at ONE clear merchant, store its normalized name as
 * match_merchant. Ambiguous or empty candidate sets are reported, never
 * guessed — the later onboarding/manual-link steps handle those.
 */

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : parseFloat(v) || 0;

const STOP = new Set(["the", "and", "for", "inc", "llc", "co", "of", "a"]);
const toks = (s: string): string[] => norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t));

/** Bill display name vs candidate merchant: shared significant token,
 * whole-word containment, or trigram similarity >= 0.5. */
const nameEvokes = (billName: string, merchant: string): boolean => {
  const bt = toks(billName);
  const mt = new Set(toks(merchant));
  if (bt.some((t) => mt.has(t))) return true;
  return trigramSimilarity(billName, merchant) >= 0.5;
};

export interface BackfillOutcome {
  billId: number;
  billName: string;
  outcome: "linked" | "no-candidates" | "ambiguous" | "no-plaid-account";
  matchMerchant?: string;
  candidates?: Array<{ merchant: string; occurrences: number }>;
}

export async function backfillMatchMerchants(opts?: { lookbackDays?: number; dryRun?: boolean }): Promise<BackfillOutcome[]> {
  const lookbackDays = opts?.lookbackDays ?? 180;
  const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const bills = await db
    .select()
    .from(billsTable)
    .where(and(eq(billsTable.isActive, true), isNotNull(billsTable.paymentAccountId), isNull(billsTable.matchMerchant)));

  const results: BackfillOutcome[] = [];

  for (const bill of bills) {
    const [account] = await db.select().from(accountsTable).where(eq(accountsTable.id, bill.paymentAccountId!));
    if (!account?.plaidAccountId) {
      results.push({ billId: bill.id, billName: bill.billName, outcome: "no-plaid-account" });
      continue;
    }

    const txns = await db
      .select()
      .from(plaidTransactionsTable)
      .where(and(
        eq(plaidTransactionsTable.accountId, account.plaidAccountId),
        gt(plaidTransactionsTable.amount, "0"),
        eq(plaidTransactionsTable.pending, false),
        gte(plaidTransactionsTable.date, sinceIso),
      ));

    const expected = num(bill.amount);
    const candidates = txns.filter(
      (t) => expected > 0 && Math.abs(num(t.amount) - expected) / expected <= 0.15,
    );

    if (candidates.length === 0) {
      results.push({ billId: bill.id, billName: bill.billName, outcome: "no-candidates" });
      continue;
    }

    // Group by normalized merchant (merchant_name preferred, else name).
    const groups = new Map<string, number>();
    for (const t of candidates) {
      const m = norm(t.merchantName) || norm(t.name);
      if (!m) continue;
      groups.set(m, (groups.get(m) ?? 0) + 1);
    }
    const ranked = [...groups.entries()]
      .map(([merchant, occurrences]) => ({ merchant, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences);

    // Clear best candidate, in priority order:
    // 1. A merchant whose name evokes the bill's display name (most frequent
    //    such group wins) — "Netflix" bill -> "netflix" merchant.
    // 2. The only candidate group there is.
    // 3. The only RECURRING group (>=2 occurrences at the bill's amount) when
    //    no name-similar group exists — "ETC internet" -> "ellijay telephone
    //    co" charged monthly. Generic one-off merchants can't win this way.
    // Anything else is ambiguous — never guess.
    // A name-similar group must also be credible: recurring (>=2 charges at
    // the bill's amount) or sharing a distinctive token (>=5 chars). A single
    // charge overlapping only on a short generic word ("food") is a guess.
    const distinctiveToken = (g: { merchant: string }) => {
      const mt = new Set(toks(g.merchant));
      return toks(bill.billName).some((t) => t.length >= 5 && mt.has(t));
    };
    const nameSimilar = ranked.filter(
      (g) => nameEvokes(bill.billName, g.merchant) && (g.occurrences >= 2 || distinctiveToken(g)),
    );
    // Non-name-similar winners need a genuine recurrence signal: their
    // charges must land on a CONSISTENT day of month (spread <= 4 days),
    // not merely repeat at the bill's amount. (A due-day ±7 gate was
    // deliberately NOT used: stored due days routinely lag the real charge
    // date by 2+ weeks and would have excluded the true merchants.)
    const daysOfGroup = (merchant: string): number[] =>
      candidates
        .filter((t) => (norm(t.merchantName) || norm(t.name)) === merchant)
        .map((t) => Number(t.date.slice(8, 10)));
    const consistentDay = (g: { merchant: string; occurrences: number }): boolean => {
      const days = daysOfGroup(g.merchant);
      if (days.length < 2) return false;
      const spread = Math.max(...days) - Math.min(...days);
      return Math.min(spread, 31 - spread) <= 4; // circular month distance
    };
    const recurring = ranked.filter((g) => g.occurrences >= 2 && consistentDay(g));
    const winner =
      nameSimilar.length > 0 ? nameSimilar[0]
      : ranked.length === 1 ? ranked[0]
      : recurring.length === 1 ? recurring[0]
      : undefined;

    if (!winner) {
      results.push({ billId: bill.id, billName: bill.billName, outcome: "ambiguous", candidates: ranked });
      continue;
    }

    if (!opts?.dryRun) {
      await db.update(billsTable).set({ matchMerchant: winner.merchant }).where(eq(billsTable.id, bill.id));
    }
    results.push({ billId: bill.id, billName: bill.billName, outcome: "linked", matchMerchant: winner.merchant, candidates: ranked });
  }

  return results;
}
