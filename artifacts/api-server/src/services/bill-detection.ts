import { and, eq, gte, gt, sql, notInArray } from "drizzle-orm";
import { db, plaidTransactionsTable, detectedBillsTable, billsTable } from "@workspace/db";
import { logger } from "../lib/logger";

// ── Thresholds (all tunables live here) ─────────────────────────────────────
/** Lookback window for candidate transactions. */
const LOOKBACK_DAYS = 365;
/** Minimum transactions for a merchant group to be considered at all. */
const MIN_GROUP_SIZE = 2;
/** Cadence buckets: median day-gap target ± tolerance. */
const CADENCE_BUCKETS = [
  { frequency: "weekly", days: 7, tolerance: 2 },
  { frequency: "biweekly", days: 14, tolerance: 3 },
  { frequency: "monthly", days: 30, tolerance: 5 },
  { frequency: "quarterly", days: 91, tolerance: 10 },
  { frequency: "annual", days: 365, tolerance: 20 },
] as const;
/** Minimum occurrences for short cadences (weekly/biweekly/monthly). */
const MIN_OCCURRENCES_SHORT = 2;
/** Minimum occurrences for long cadences (quarterly/annual). */
const MIN_OCCURRENCES_LONG = 2;
const SHORT_FREQUENCIES = new Set(["weekly", "biweekly", "monthly"]);
/** Default CV ceiling above which a group is too erratic to be a bill. */
const CV_MAX = 0.4;
/** Raised CV ceiling for subscription-like categories (usage-based amounts). */
const CV_MAX_SUBSCRIPTION = 0.75;
/** personal_finance_category prefixes that qualify for the raised CV ceiling. */
const SUBSCRIPTION_CV_CATEGORIES = ["GENERAL_SERVICES", "ENTERTAINMENT", "RENT_AND_UTILITIES"];
/** CV above which a kept group is flagged as a variable-amount bill. */
const CV_VARIABLE_THRESHOLD = 0.15;
/** Confidence blend weights (must sum to 1). */
const WEIGHT_CADENCE = 0.4;
const WEIGHT_AMOUNT = 0.35;
const WEIGHT_OCCURRENCES = 0.25;
/** Occurrence count at which the occurrence score maxes out. */
const OCCURRENCE_CAP = 6;
/** Thin-evidence confidence multipliers by occurrence count (>=4 → no penalty). */
const OCCURRENCE_PENALTY: Record<number, number> = { 2: 0.7, 3: 0.85 };
/** Fuzzy merchant-key merge: similarity threshold on space-stripped keys. */
const MERGE_KEY_SIMILARITY = 0.7;
/** Reconciliation: name similarity (pg_trgm) and amount tolerance vs existing bills. */
const RECONCILE_NAME_SIMILARITY = 0.7;
const RECONCILE_AMOUNT_TOLERANCE = 0.15;
/** personal_finance_category prefixes that INDICATE a transfer / CC payment (necessary, not sufficient). */
const TRANSFER_CATEGORY_PREFIXES = ["TRANSFER_OUT", "TRANSFER_IN", "LOAN_PAYMENTS"];
/** personal_finance_category_detailed substrings that INDICATE a CC payment. */
const TRANSFER_DETAILED_SUBSTRINGS = ["CREDIT_CARD_PAYMENT"];
/** Normalized-name substrings that mark card payments / transfers. */
const EXCLUDED_NAME_PATTERNS = [
  "online pmt",
  "online payment",
  "card payment",
  "transfer money to",
  "external transfer",
  "mobile deposit",
  "bank transfer",
  "autopay payment",
  "recurring transfer to",
];
/** "epay" only counts as a card-payment pattern when combined with a card issuer name. */
const CARD_ISSUER_NAMES = [
  "capital one",
  "chase",
  "amex",
  "american express",
  "discover",
  "citi",
  "synchrony",
  "barclays",
  "wells fargo",
  "bank of america",
  "us bank",
  "usbank",
];
/** Never exclude a transaction whose normalized name contains one of these.
 *  Groups containing these words also get the raised CV ceiling — insurance
 *  premiums and utilities legitimately vary in amount (e.g. USAA CV ≈ 0.44). */
const EXCLUSION_ALLOWLIST = ["insurance", "premium", "mortgage", "loan payment", "utilities"];

export interface DetectionSummary {
  detected: number;
  pending: number;
  duplicates: number;
  excludedTransfers: number;
  mergesPerformed: number;
}

/** Normalize a raw merchant string into a stable grouping key. */
export function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\*+/g, " "); // asterisk runs (e.g. "AMZN*Prime")
  s = s.replace(/\b(ref number|ppd id|des:|id:)\s*\S*/gi, " ");
  s = s.replace(/\b(xxxx+|x{2,}\d+|#{2,})\S*/gi, " ");
  s = s.replace(/#\d+/g, " "); // store numbers with #
  s = s.replace(/\b\d{2}[\/\-]\d{2}(?:[\/\-]\d{2,4})?\b/g, " "); // dates
  s = s.replace(/\b[a-z]{2,4}\d{2,}[a-z0-9]*\b/gi, " "); // reference codes like CAO88XXXX / wfct12...
  s = s.replace(/\b\d{3,}\b/g, " "); // standalone store numbers / long digit runs
  s = s.replace(/[^\w\s&'.-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s\-.'&]+|[\s\-.'&]+$/g, "");
  return s;
}

interface Txn {
  id: number;
  plaidTransactionId: string;
  amount: string;
  date: string;
  name: string | null;
  merchantName: string | null;
  personalFinanceCategory: string | null;
  personalFinanceCategoryDetailed: string | null;
}

/**
 * Narrow exclusion (Change 3): a transaction is excluded ONLY if BOTH the Plaid
 * category indicates a transfer/CC payment AND the normalized name matches a
 * transfer/card-payment pattern. Allowlisted bill words always win.
 */
function isExcluded(txn: Txn, normalizedName: string): { category: string; pattern: string } | null {
  if (EXCLUSION_ALLOWLIST.some((w) => normalizedName.includes(w))) return null;
  const pfc = txn.personalFinanceCategory ?? "";
  const detailed = txn.personalFinanceCategoryDetailed ?? "";
  const categoryMatch =
    TRANSFER_CATEGORY_PREFIXES.find((p) => pfc.startsWith(p) || detailed.startsWith(p)) ??
    TRANSFER_DETAILED_SUBSTRINGS.find((s) => detailed.includes(s));
  if (!categoryMatch) return null;
  let pattern = EXCLUDED_NAME_PATTERNS.find((p) => normalizedName.includes(p));
  if (!pattern && normalizedName.includes("epay") && CARD_ISSUER_NAMES.some((c) => normalizedName.includes(c))) {
    pattern = "epay + card issuer";
  }
  if (!pattern) return null;
  return { category: categoryMatch, pattern };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayGap(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MerchantGroup {
  key: string;
  txns: Txn[];
  /** True if the key was derived from a Plaid merchant_name (cleaner source). */
  fromMerchantName: boolean;
}

/** Whole-word substring containment or high similarity after removing spaces. */
function keysMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (new RegExp(`\\b${escapeRegExp(shorter)}\\b`).test(longer)) return true;
  const da = a.replace(/\s+/g, "");
  const db_ = b.replace(/\s+/g, "");
  return levenshteinRatio(da, db_) >= MERGE_KEY_SIMILARITY;
}

/** Prefer merchant_name-derived keys; among ties, prefer the shorter key. */
function pickCanonical(a: MerchantGroup, b: MerchantGroup): MerchantGroup {
  if (a.fromMerchantName !== b.fromMerchantName) return a.fromMerchantName ? a : b;
  return a.key.length <= b.key.length ? a : b;
}

/** Fuzzy merge pass (Change 1): merges split merchant keys before cadence analysis. */
function mergeSimilarGroups(groups: MerchantGroup[]): { merged: MerchantGroup[]; merges: number } {
  const clusters: MerchantGroup[] = [];
  let merges = 0;
  for (const group of [...groups].sort((a, b) => a.key.length - b.key.length)) {
    const match = clusters.find((c) => keysMatch(c.key, group.key));
    if (!match) {
      clusters.push({ ...group, txns: [...group.txns] });
      continue;
    }
    const canonical = pickCanonical(match, group);
    logger.info(`MERGED: ${group.key} + ${match.key} -> ${canonical.key}`);
    merges++;
    match.txns.push(...group.txns);
    match.key = canonical.key;
    match.fromMerchantName = match.fromMerchantName || group.fromMerchantName;
  }
  return { merged: clusters, merges };
}

/** Detect recurring bills from synced Plaid transactions and upsert into the review queue. */
export async function detectBills(userId: string): Promise<DetectionSummary> {
  const cutoff = addDaysIso(new Date().toISOString().slice(0, 10), -LOOKBACK_DAYS);
  const txns: Txn[] = await db
    .select({
      id: plaidTransactionsTable.id,
      plaidTransactionId: plaidTransactionsTable.plaidTransactionId,
      amount: plaidTransactionsTable.amount,
      date: plaidTransactionsTable.date,
      name: plaidTransactionsTable.name,
      merchantName: plaidTransactionsTable.merchantName,
      personalFinanceCategory: plaidTransactionsTable.personalFinanceCategory,
      personalFinanceCategoryDetailed: plaidTransactionsTable.personalFinanceCategoryDetailed,
    })
    .from(plaidTransactionsTable)
    .where(
      and(
        eq(plaidTransactionsTable.userId, userId),
        eq(plaidTransactionsTable.pending, false),
        gt(plaidTransactionsTable.amount, "0"),
        gte(plaidTransactionsTable.date, cutoff),
      ),
    );

  // Exclude transfers / CC payments (narrow rule), normalize, group.
  let excludedTransfers = 0;
  const rawGroups = new Map<string, MerchantGroup>();
  const samplePairs: string[] = [];
  for (const txn of txns) {
    const rawSource = txn.merchantName || txn.name || "";
    if (!rawSource.trim()) continue;
    const key = normalizeMerchant(rawSource);
    if (!key) continue;
    if (samplePairs.length < 15) samplePairs.push(`"${rawSource}" -> "${key}"`);
    const excluded = isExcluded(txn, key);
    if (excluded) {
      excludedTransfers++;
      logger.info(
        { key, category: excluded.category, pattern: excluded.pattern },
        "Bill detection: excluded transfer/card payment",
      );
      continue;
    }
    const group = rawGroups.get(key) ?? { key, txns: [], fromMerchantName: false };
    if (txn.merchantName) group.fromMerchantName = true;
    group.txns.push(txn);
    rawGroups.set(key, group);
  }
  logger.info(
    { userId, total: txns.length, excludedTransfers, rawGroups: rawGroups.size },
    "Bill detection: exclusion pass complete",
  );
  logger.info({ samples: samplePairs }, "Bill detection: raw -> normalized samples");

  // Fuzzy merge pass.
  const { merged, merges } = mergeSimilarGroups([...rawGroups.values()]);
  logger.info({ mergesPerformed: merges, groupsAfterMerge: merged.length }, "Bill detection: fuzzy merge complete");

  let detected = 0;
  const detectedKeys: string[] = [];
  for (const group of merged) {
    if (group.txns.length < MIN_GROUP_SIZE) continue;
    const merchantKey = group.key;
    // Collapse same-day charges into one occurrence (summed amount): duplicate
    // same-day rows create 0-day gaps that break the median-gap cadence math.
    const byDate = new Map<string, Txn[]>();
    for (const txn of group.txns) {
      const list = byDate.get(txn.date) ?? [];
      list.push(txn);
      byDate.set(txn.date, list);
    }
    const sorted = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, list]) => ({
        ...list[0]!,
        date,
        amount: String(list.reduce((sum, t) => sum + parseFloat(String(t.amount)), 0)),
        allTxns: list,
      }));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(dayGap(sorted[i - 1]!.date, sorted[i]!.date));
    if (gaps.length === 0) continue;
    const medGap = median(gaps);
    const bucket = CADENCE_BUCKETS.find((b) => Math.abs(medGap - b.days) <= b.tolerance);
    if (!bucket) continue;
    const minOccurrences = SHORT_FREQUENCIES.has(bucket.frequency) ? MIN_OCCURRENCES_SHORT : MIN_OCCURRENCES_LONG;
    if (sorted.length < minOccurrences) continue;

    const amounts = sorted.map((t) => parseFloat(String(t.amount)));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stddev = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
    const cv = mean === 0 ? Infinity : stddev / mean;
    // Change 5: subscription-like categories get a raised CV ceiling; so do
    // allowlisted bill words (insurance/premium/mortgage/…): genuinely variable.
    const dominantCategory = mostCommon(sorted.map((t) => t.personalFinanceCategory ?? "").filter(Boolean)) ?? "";
    const cvMax =
      SUBSCRIPTION_CV_CATEGORIES.some((p) => dominantCategory.startsWith(p)) ||
      EXCLUSION_ALLOWLIST.some((w) => merchantKey.includes(w))
        ? CV_MAX_SUBSCRIPTION
        : CV_MAX;
    if (cv > cvMax) continue;
    const isVariable = cv > CV_VARIABLE_THRESHOLD;

    // Confidence: cadence tightness + amount stability + occurrence count.
    const gapDeviation = gaps.reduce((a, g) => a + Math.abs(g - bucket.days), 0) / gaps.length / bucket.tolerance;
    const cadenceScore = Math.max(0, 1 - Math.min(gapDeviation, 2) / 2);
    const amountScore = Math.max(0, 1 - cv / cvMax);
    const occurrenceScore = Math.min(sorted.length / OCCURRENCE_CAP, 1);
    const rawConfidence = Math.min(
      1,
      WEIGHT_CADENCE * cadenceScore + WEIGHT_AMOUNT * amountScore + WEIGHT_OCCURRENCES * occurrenceScore,
    );
    // Change 4: thin-evidence penalty so 2- and 3-occurrence detections rank lower.
    const confidence = rawConfidence * (OCCURRENCE_PENALTY[sorted.length] ?? 1);

    // Display name: best merchant_name in the merged group, else most common raw name.
    const merchantNames = sorted.map((t) => t.merchantName).filter((v): v is string => Boolean(v));
    const displayName =
      mostCommon(merchantNames) ?? mostCommon(sorted.map((t) => t.name ?? "").filter(Boolean)) ?? merchantKey;

    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const values = {
      userId,
      merchantKey,
      displayName,
      amount: median(amounts).toFixed(2),
      amountMin: Math.min(...amounts).toFixed(2),
      amountMax: Math.max(...amounts).toFixed(2),
      isVariable,
      frequency: bucket.frequency,
      occurrenceCount: sorted.length,
      firstSeen: first.date,
      lastSeen: last.date,
      nextExpectedDate: addDaysIso(last.date, bucket.days),
      confidence: confidence.toFixed(2),
      sampleTxnIds: sorted.flatMap((t) => t.allTxns.map((x) => x.plaidTransactionId)),
      updatedAt: new Date(),
    };
    // Upsert; never overwrite status/duplicateOf on rows already reviewed.
    await db
      .insert(detectedBillsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [detectedBillsTable.userId, detectedBillsTable.merchantKey, detectedBillsTable.frequency],
        set: {
          displayName: values.displayName,
          amount: values.amount,
          amountMin: values.amountMin,
          amountMax: values.amountMax,
          isVariable: values.isVariable,
          occurrenceCount: values.occurrenceCount,
          firstSeen: values.firstSeen,
          lastSeen: values.lastSeen,
          nextExpectedDate: values.nextExpectedDate,
          confidence: values.confidence,
          sampleTxnIds: values.sampleTxnIds,
          updatedAt: values.updatedAt,
        },
      });
    detected++;
    detectedKeys.push(merchantKey);
    logger.info(
      {
        merchantKey,
        displayName: values.displayName,
        frequency: values.frequency,
        occurrenceCount: values.occurrenceCount,
        medianGap: medGap,
        amount: values.amount,
        cv: Number(cv.toFixed(3)),
        rawConfidence: Number(rawConfidence.toFixed(3)),
        adjustedConfidence: values.confidence,
      },
      "Bill detection: candidate detected",
    );
  }

  // Cleanup: merchant keys change when fuzzy grouping merges; drop stale PENDING rows
  // whose key no longer appears in this run. Confirmed/dismissed/duplicate rows are kept.
  const staleFilter = detectedKeys.length
    ? and(
        eq(detectedBillsTable.userId, userId),
        eq(detectedBillsTable.status, "pending"),
        notInArray(detectedBillsTable.merchantKey, detectedKeys),
      )
    : and(eq(detectedBillsTable.userId, userId), eq(detectedBillsTable.status, "pending"));
  const stale = await db.delete(detectedBillsTable).where(staleFilter).returning({ id: detectedBillsTable.id });
  if (stale.length) logger.info({ removed: stale.length }, "Bill detection: removed stale pending rows");

  const duplicates = await reconcileAgainstBills(userId);
  const [{ pending }] = (await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(detectedBillsTable)
    .where(and(eq(detectedBillsTable.userId, userId), eq(detectedBillsTable.status, "pending")))) as [{ pending: number }];

  return { detected, pending, duplicates, excludedTransfers, mergesPerformed: merges };
}

/** App-side fallback name similarity (Levenshtein ratio) when pg_trgm is unavailable. */
function levenshteinRatio(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (!s.length && !t.length) return 1;
  const m = s.length;
  const n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

let pgTrgmAvailable: boolean | null = null;

async function nameSimilarity(a: string, b: string): Promise<number> {
  if (pgTrgmAvailable !== false) {
    try {
      const result = await db.execute(sql`SELECT similarity(${a}, ${b}) AS sim`);
      pgTrgmAvailable = true;
      return Number((result.rows?.[0] as { sim?: number } | undefined)?.sim ?? 0);
    } catch (err) {
      pgTrgmAvailable = false;
      logger.warn({ err }, "pg_trgm similarity() unavailable; falling back to app-side Levenshtein ratio");
    }
  }
  return levenshteinRatio(a, b);
}

/** Mark pending detections as duplicates of existing bills (name similarity + amount + frequency). */
async function reconcileAgainstBills(userId: string): Promise<number> {
  const pendingRows = await db
    .select()
    .from(detectedBillsTable)
    .where(and(eq(detectedBillsTable.userId, userId), eq(detectedBillsTable.status, "pending")));
  const bills = await db.select().from(billsTable).where(eq(billsTable.userId, userId));
  let duplicates = 0;
  for (const det of pendingRows) {
    for (const bill of bills) {
      if (bill.frequency !== det.frequency) continue;
      const billAmount = Math.abs(parseFloat(String(bill.amount)));
      const detAmount = Math.abs(parseFloat(String(det.amount)));
      if (billAmount === 0 || Math.abs(billAmount - detAmount) / billAmount > RECONCILE_AMOUNT_TOLERANCE) continue;
      const sim = await nameSimilarity(det.displayName, bill.billName);
      if (sim < RECONCILE_NAME_SIMILARITY) continue;
      await db
        .update(detectedBillsTable)
        .set({ status: "duplicate", duplicateOf: bill.id, updatedAt: new Date() })
        .where(eq(detectedBillsTable.id, det.id));
      duplicates++;
      break;
    }
  }
  return duplicates;
}
