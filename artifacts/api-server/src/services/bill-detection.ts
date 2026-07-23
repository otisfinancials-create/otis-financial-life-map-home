import { and, eq, gte, gt, sql } from "drizzle-orm";
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
/** Minimum occurrences per frequency (quarterly/annual need fewer). */
const MIN_OCCURRENCES: Record<string, number> = {
  weekly: 3,
  biweekly: 3,
  monthly: 3,
  quarterly: 2,
  annual: 2,
};
/** Coefficient of variation above which a group is too erratic to be a bill. */
const CV_REJECT_THRESHOLD = 0.4;
/** CV above which a kept group is flagged as a variable-amount bill. */
const CV_VARIABLE_THRESHOLD = 0.15;
/** Confidence blend weights (must sum to 1). */
const WEIGHT_CADENCE = 0.4;
const WEIGHT_AMOUNT = 0.35;
const WEIGHT_OCCURRENCES = 0.25;
/** Occurrence count at which the occurrence score maxes out. */
const OCCURRENCE_CAP = 6;
/** Reconciliation: name similarity (pg_trgm) and amount tolerance vs existing bills. */
const RECONCILE_NAME_SIMILARITY = 0.7;
const RECONCILE_AMOUNT_TOLERANCE = 0.15;
/** personal_finance_category prefixes that mark transfers / CC payments. */
const EXCLUDED_CATEGORY_PREFIXES = ["TRANSFER_OUT", "TRANSFER_IN", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"];
/** personal_finance_category_detailed substrings that mark CC payments. */
const EXCLUDED_DETAILED_SUBSTRINGS = ["CREDIT_CARD_PAYMENT"];
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

export interface DetectionSummary {
  detected: number;
  pending: number;
  duplicates: number;
  excludedTransfers: number;
}

/** Normalize a raw merchant string into a stable grouping key. */
export function normalizeMerchant(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\b(ref number|ppd id|des:|id:)\s*\S*/gi, " ");
  s = s.replace(/\b(xxxx+|x{2,}\d+|#{2,})\S*/gi, " ");
  s = s.replace(/#\d+/g, " "); // store numbers
  s = s.replace(/\b\d{2}[\/\-]\d{2}(?:[\/\-]\d{2,4})?\b/g, " "); // dates
  s = s.replace(/\b[a-z]{2,4}\d{2,}[a-z0-9]*\b/gi, " "); // reference codes like CAO88XXXX / wfct12...
  s = s.replace(/\b\d{5,}\b/g, " "); // long digit runs
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

function isExcluded(txn: Txn, normalizedName: string): "category" | "name" | null {
  const pfc = txn.personalFinanceCategory ?? "";
  const detailed = txn.personalFinanceCategoryDetailed ?? "";
  if (EXCLUDED_CATEGORY_PREFIXES.some((p) => pfc.startsWith(p) || detailed.startsWith(p))) return "category";
  if (EXCLUDED_DETAILED_SUBSTRINGS.some((s) => detailed.includes(s))) return "category";
  if (EXCLUDED_NAME_PATTERNS.some((p) => normalizedName.includes(p))) return "name";
  return null;
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

  // Exclude transfers / CC payments, normalize, group.
  let excludedByCategory = 0;
  let excludedByName = 0;
  const groups = new Map<string, { display: string; txns: Txn[] }>();
  const samplePairs: string[] = [];
  for (const txn of txns) {
    const rawSource = txn.merchantName || txn.name || "";
    if (!rawSource.trim()) continue;
    const key = normalizeMerchant(rawSource);
    if (!key) continue;
    if (samplePairs.length < 15) samplePairs.push(`"${rawSource}" -> "${key}"`);
    const excluded = isExcluded(txn, key);
    if (excluded === "category") {
      excludedByCategory++;
      continue;
    }
    if (excluded === "name") {
      excludedByName++;
      continue;
    }
    const group = groups.get(key) ?? { display: rawSource, txns: [] };
    // Prefer a clean merchant_name for display.
    if (txn.merchantName) group.display = txn.merchantName;
    group.txns.push(txn);
    groups.set(key, group);
  }
  logger.info(
    { userId, total: txns.length, excludedByCategory, excludedByName, groups: groups.size },
    "Bill detection: exclusion pass complete",
  );
  logger.info({ samples: samplePairs }, "Bill detection: raw -> normalized samples");

  let detected = 0;
  for (const [merchantKey, group] of groups) {
    if (group.txns.length < MIN_GROUP_SIZE) continue;
    const sorted = [...group.txns].sort((a, b) => a.date.localeCompare(b.date));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(dayGap(sorted[i - 1]!.date, sorted[i]!.date));
    if (gaps.length === 0) continue;
    const medGap = median(gaps);
    const bucket = CADENCE_BUCKETS.find((b) => Math.abs(medGap - b.days) <= b.tolerance);
    if (!bucket) continue;
    if (sorted.length < (MIN_OCCURRENCES[bucket.frequency] ?? 3)) continue;

    const amounts = sorted.map((t) => parseFloat(String(t.amount)));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stddev = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
    const cv = mean === 0 ? Infinity : stddev / mean;
    if (cv > CV_REJECT_THRESHOLD) continue;
    const isVariable = cv > CV_VARIABLE_THRESHOLD;

    // Confidence: cadence tightness + amount stability + occurrence count.
    const gapDeviation = gaps.length
      ? gaps.reduce((a, g) => a + Math.abs(g - bucket.days), 0) / gaps.length / bucket.tolerance
      : 1;
    const cadenceScore = Math.max(0, 1 - Math.min(gapDeviation, 2) / 2);
    const amountScore = Math.max(0, 1 - cv / CV_REJECT_THRESHOLD);
    const occurrenceScore = Math.min(sorted.length / OCCURRENCE_CAP, 1);
    const confidence = Math.min(
      1,
      WEIGHT_CADENCE * cadenceScore + WEIGHT_AMOUNT * amountScore + WEIGHT_OCCURRENCES * occurrenceScore,
    );

    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const values = {
      userId,
      merchantKey,
      displayName: group.display,
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
      sampleTxnIds: sorted.map((t) => t.plaidTransactionId),
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
    logger.info(
      {
        merchantKey,
        displayName: values.displayName,
        frequency: values.frequency,
        occurrenceCount: values.occurrenceCount,
        amount: values.amount,
        cv: Number(cv.toFixed(3)),
        confidence: values.confidence,
      },
      "Bill detection: candidate detected",
    );
  }

  const duplicates = await reconcileAgainstBills(userId);
  const [{ pending }] = (await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(detectedBillsTable)
    .where(and(eq(detectedBillsTable.userId, userId), eq(detectedBillsTable.status, "pending")))) as [{ pending: number }];

  return { detected, pending, duplicates, excludedTransfers: excludedByCategory + excludedByName };
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
