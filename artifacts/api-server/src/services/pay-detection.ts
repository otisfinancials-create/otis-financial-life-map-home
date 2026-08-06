import { and, eq, gte, lt, sql, like } from "drizzle-orm";
import {
  db,
  plaidTransactionsTable,
  detectedPaySchedulesTable,
  paySchedulesTable,
  accountsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { normalizeMerchant, mergeSimilarGroups, type MerchantGroup } from "./bill-detection";

// ── Thresholds ───────────────────────────────────────────────────────────────
/** Lookback window for candidate inflows. */
const LOOKBACK_DAYS = 365;
/** Minimum deposits for an employer group to be proposed (excludes one-offs). */
const MIN_OCCURRENCES = 3;
/** Minimum occurrences required to distinguish biweekly from semi-monthly.
 *  Below this, the ~14-day cadences are genuinely ambiguous — biweekly drifts
 *  and produces three-paycheck months, semi-monthly does not — so the user
 *  must pick. */
const MIN_OCCURRENCES_TO_DISAMBIGUATE = 6;
/** Detailed Plaid income categories that count as recurring-pay signal.
 *  Deliberately excluded: INCOME_TAX_REFUND (one-off), TRANSFER_IN_* (asset
 *  movement between the user's own accounts, Zelle/app transfers, deposits). */
const INCOME_CATEGORY_PREFIX = "INCOME";
const EXCLUDED_DETAILED_CATEGORIES = new Set(["INCOME_TAX_REFUND"]);
/** Inflows whose name matches these are never pay, whatever the category —
 *  Plaid tags some Zelle inflows INCOME_CONTRACTOR. */
const EXCLUDED_NAME_PATTERNS = ["zelle", "venmo", "cash app", "cashapp", "paypal", "mobile deposit", "mspbna", "morgan stanley", "online transfer", "bank transfer"];
/** Dedupe against existing pay_schedules: name similarity threshold. */
const DUPLICATE_NAME_SIMILARITY = 0.7;

export interface PayDetectionSummary {
  detected: number;
  pending: number;
  duplicates: number;
  excluded: number;
}

interface Txn {
  plaidTransactionId: string;
  amount: string;
  date: string;
  name: string | null;
  merchantName: string | null;
  personalFinanceCategoryDetailed: string | null;
}

function dayGap(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
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

function nextByFrequency(lastIso: string, frequency: string): string {
  const d = new Date(`${lastIso}T00:00:00Z`);
  switch (frequency) {
    case "weekly": return addDaysIso(lastIso, 7);
    case "biweekly": return addDaysIso(lastIso, 14);
    case "semi-monthly":
      if (d.getUTCDate() < 15) { d.setUTCDate(15); }
      else { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(1); }
      return d.toISOString().slice(0, 10);
    case "monthly": {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
      return d.toISOString().slice(0, 10);
    }
    default: return addDaysIso(lastIso, 14);
  }
}

interface CadenceResult {
  frequency: string;
  ambiguous: boolean;
  options: string[];
  /** Human-readable evidence: gaps observed, weekday consistency, etc. */
  evidence: { medianGap: number; gaps: number[]; weekdayShare: number; occurrencesUsed: number };
}

/** Infer pay cadence from same-day-collapsed deposit dates. */
export function inferCadence(dates: string[]): CadenceResult | null {
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(dayGap(dates[i - 1]!, dates[i]!));
  if (gaps.length === 0) return null;
  const medGap = median(gaps);
  const weekdays = dates.map((d) => new Date(`${d}T00:00:00Z`).getUTCDay());
  const weekdayCounts = new Map<number, number>();
  for (const w of weekdays) weekdayCounts.set(w, (weekdayCounts.get(w) ?? 0) + 1);
  const weekdayShare = Math.max(...weekdayCounts.values()) / weekdays.length;
  const evidence = { medianGap: medGap, gaps, weekdayShare: Number(weekdayShare.toFixed(2)), occurrencesUsed: dates.length };

  if (medGap >= 5 && medGap <= 9) return { frequency: "weekly", ambiguous: false, options: [], evidence };

  if (medGap >= 12 && medGap <= 17) {
    // Biweekly vs semi-monthly. Biweekly: constant ~14d gaps landing on the
    // same weekday, day-of-month drifting across the whole month. Semi-monthly:
    // gaps alternate (~13/17), payments cluster on two day-of-month anchors.
    if (dates.length < MIN_OCCURRENCES_TO_DISAMBIGUATE) {
      return { frequency: "biweekly", ambiguous: true, options: ["biweekly", "semi-monthly"], evidence };
    }
    const doms = dates.map((d) => Number(d.slice(8, 10)));
    // Two-anchor fit: cluster day-of-months around the two most common values.
    const domCounts = new Map<number, number>();
    for (const dom of doms) domCounts.set(dom, (domCounts.get(dom) ?? 0) + 1);
    const anchors = [...domCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d);
    const nearAnchor = doms.filter((d) => anchors.some((a) => Math.abs(d - a) <= 2)).length / doms.length;
    const biweeklyLike = weekdayShare >= 0.8;
    const semiMonthlyLike = nearAnchor >= 0.85;
    if (biweeklyLike && !semiMonthlyLike) return { frequency: "biweekly", ambiguous: false, options: [], evidence };
    if (semiMonthlyLike && !biweeklyLike) return { frequency: "semi-monthly", ambiguous: false, options: [], evidence };
    return { frequency: "biweekly", ambiguous: true, options: ["biweekly", "semi-monthly"], evidence };
  }

  if (medGap >= 26 && medGap <= 35) return { frequency: "monthly", ambiguous: false, options: [], evidence };
  return null; // irregular — not recurring pay
}

/** Detect recurring income on forecast-pool accounts and upsert into the review queue. */
export async function detectPaySchedules(userId: string): Promise<PayDetectionSummary> {
  const cutoff = addDaysIso(new Date().toISOString().slice(0, 10), -LOOKBACK_DAYS);

  const forecastAccounts = await db
    .select({ plaidAccountId: accountsTable.plaidAccountId })
    .from(accountsTable)
    .where(and(eq(accountsTable.userId, userId), eq(accountsTable.isForecastAccount, true)));
  const plaidAcctIds = forecastAccounts.map((a) => a.plaidAccountId).filter((x): x is string => x != null);
  if (plaidAcctIds.length === 0) return { detected: 0, pending: 0, duplicates: 0, excluded: 0 };

  // Inflows are NEGATIVE amounts in plaid_transactions (Plaid: positive = outflow).
  const txns: Txn[] = await db
    .select({
      plaidTransactionId: plaidTransactionsTable.plaidTransactionId,
      amount: plaidTransactionsTable.amount,
      date: plaidTransactionsTable.date,
      name: plaidTransactionsTable.name,
      merchantName: plaidTransactionsTable.merchantName,
      personalFinanceCategoryDetailed: plaidTransactionsTable.personalFinanceCategoryDetailed,
    })
    .from(plaidTransactionsTable)
    .where(and(
      eq(plaidTransactionsTable.userId, userId),
      eq(plaidTransactionsTable.pending, false),
      lt(plaidTransactionsTable.amount, "0"),
      gte(plaidTransactionsTable.date, cutoff),
      sql`${plaidTransactionsTable.accountId} IN (${sql.join(plaidAcctIds.map((id) => sql`${id}`), sql`, `)})`,
    ));

  // Primary signal: Plaid income categories. Exclude own-account transfers,
  // Zelle/app transfers, refunds — they are TRANSFER_IN_* or excluded by name.
  let excluded = 0;
  const rawGroups = new Map<string, MerchantGroup>();
  for (const txn of txns) {
    const detailed = txn.personalFinanceCategoryDetailed ?? "";
    const rawLower = `${txn.name ?? ""} ${txn.merchantName ?? ""}`.toLowerCase();
    const isIncome = detailed.startsWith(INCOME_CATEGORY_PREFIX) && !EXCLUDED_DETAILED_CATEGORIES.has(detailed);
    const nameExcluded = EXCLUDED_NAME_PATTERNS.find((p) => rawLower.includes(p));
    if (!isIncome || nameExcluded) {
      excluded++;
      if (isIncome && nameExcluded) {
        logger.info({ name: txn.name, pattern: nameExcluded, detailed }, "Pay detection: income-tagged inflow excluded by name pattern");
      }
      continue;
    }
    const rawSource = txn.merchantName || txn.name || "";
    const key = normalizeMerchant(rawSource);
    if (!key) { excluded++; continue; }
    const group = rawGroups.get(key) ?? { key, txns: [], fromMerchantName: false };
    if (txn.merchantName) group.fromMerchantName = true;
    // MerchantGroup.txns is typed for bill detection's Txn; we only use the
    // fields both shapes share (amount/date/name/merchantName).
    group.txns.push(txn as never);
    rawGroups.set(key, group);
  }

  // Fuzzy merge: payroll descriptors drift ("DIR DEP" vs "PAYROLL") — same employer.
  const { merged } = mergeSimilarGroups([...rawGroups.values()]);

  let detected = 0;
  const detectedPairs: Array<{ employerKey: string; frequency: string }> = [];
  for (const group of merged) {
    // Collapse same-day deposits WITHIN one employer (split direct deposits),
    // never across employers — grouping is strictly by normalized name.
    const byDate = new Map<string, number>();
    for (const t of group.txns as unknown as Txn[]) {
      byDate.set(t.date, (byDate.get(t.date) ?? 0) + Math.abs(parseFloat(String(t.amount))));
    }
    const occurrences = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (occurrences.length < MIN_OCCURRENCES) continue;

    const dates = occurrences.map(([d]) => d);
    const cadence = inferCadence(dates);
    if (!cadence) {
      logger.info({ employerKey: group.key, occurrences: dates.length }, "Pay detection: irregular cadence, skipped");
      continue;
    }

    const amounts = occurrences.map(([, a]) => a);
    const lastAmount = amounts[amounts.length - 1]!;
    const gapsInBand = cadence.evidence.gaps.filter((g) => Math.abs(g - cadence.evidence.medianGap) <= 3).length;
    const confidence = Math.min(1, Math.max(0.1, gapsInBand / Math.max(1, cadence.evidence.gaps.length)));

    const txnsInGroup = group.txns as unknown as Txn[];
    const merchantNames = txnsInGroup.map((t) => t.merchantName).filter((v): v is string => Boolean(v));
    const nameCounts = new Map<string, number>();
    for (const n of (merchantNames.length ? merchantNames : txnsInGroup.map((t) => t.name ?? ""))) {
      if (n) nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    }
    const displayName = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.key;

    const values = {
      userId,
      employerKey: group.key,
      displayName,
      amount: lastAmount.toFixed(2),
      amountMin: Math.min(...amounts).toFixed(2),
      amountMax: Math.max(...amounts).toFixed(2),
      frequency: cadence.frequency,
      cadenceAmbiguous: cadence.ambiguous,
      frequencyOptions: cadence.ambiguous ? cadence.options : null,
      occurrenceCount: occurrences.length,
      firstSeen: dates[0]!,
      lastSeen: dates[dates.length - 1]!,
      nextExpectedDate: nextByFrequency(dates[dates.length - 1]!, cadence.frequency),
      confidence: confidence.toFixed(2),
      sampleTxnIds: txnsInGroup.map((t) => t.plaidTransactionId),
      updatedAt: new Date(),
    };
    await db
      .insert(detectedPaySchedulesTable)
      .values(values)
      .onConflictDoUpdate({
        target: [detectedPaySchedulesTable.userId, detectedPaySchedulesTable.employerKey, detectedPaySchedulesTable.frequency],
        set: {
          displayName: values.displayName,
          amount: values.amount,
          amountMin: values.amountMin,
          amountMax: values.amountMax,
          cadenceAmbiguous: values.cadenceAmbiguous,
          frequencyOptions: values.frequencyOptions,
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
    detectedPairs.push({ employerKey: group.key, frequency: cadence.frequency });
    logger.info(
      { employerKey: group.key, displayName, frequency: cadence.frequency, ambiguous: cadence.ambiguous, occurrences: occurrences.length, medianGap: cadence.evidence.medianGap, weekdayShare: cadence.evidence.weekdayShare, amount: values.amount },
      "Pay detection: candidate detected",
    );
  }

  // Drop stale pending rows whose identity no longer appears (keys shift when
  // fuzzy merging changes). Confirmed/dismissed/duplicate rows are kept —
  // dismissals must persist so a proposal is never re-surfaced.
  const staleFilter = detectedPairs.length
    ? and(
        eq(detectedPaySchedulesTable.userId, userId),
        eq(detectedPaySchedulesTable.status, "pending"),
        sql`(${detectedPaySchedulesTable.employerKey}, ${detectedPaySchedulesTable.frequency}) NOT IN (${sql.join(
          detectedPairs.map((p) => sql`(${p.employerKey}, ${p.frequency})`),
          sql`, `,
        )})`,
      )
    : and(eq(detectedPaySchedulesTable.userId, userId), eq(detectedPaySchedulesTable.status, "pending"));
  await db.delete(detectedPaySchedulesTable).where(staleFilter);

  // Dedupe against existing pay schedules (mirror bill detection's reconcile):
  // same frequency + similar employer name → duplicate, not re-proposed.
  const existing = await db.select().from(paySchedulesTable).where(eq(paySchedulesTable.userId, userId));
  let duplicates = 0;
  if (existing.length > 0) {
    const pendingRows = await db
      .select()
      .from(detectedPaySchedulesTable)
      .where(and(eq(detectedPaySchedulesTable.userId, userId), eq(detectedPaySchedulesTable.status, "pending")));
    for (const det of pendingRows) {
      for (const ps of existing) {
        const a = normalizeMerchant(ps.employerName);
        const b = det.employerKey;
        const contained = a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a));
        if (!contained && levenshteinRatio(a, b) < DUPLICATE_NAME_SIMILARITY) continue;
        await db
          .update(detectedPaySchedulesTable)
          .set({ status: "duplicate", duplicateOf: ps.id, updatedAt: new Date() })
          .where(eq(detectedPaySchedulesTable.id, det.id));
        duplicates++;
        break;
      }
    }
  }

  const [{ pending }] = (await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(detectedPaySchedulesTable)
    .where(and(eq(detectedPaySchedulesTable.userId, userId), eq(detectedPaySchedulesTable.status, "pending")))) as [{ pending: number }];

  return { detected, pending, duplicates, excluded };
}

function levenshteinRatio(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (!s.length && !t.length) return 1;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const curr = [i, ...new Array<number>(t.length).fill(0)];
    for (let j = 1; j <= t.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[t.length]! / Math.max(s.length, t.length);
}
