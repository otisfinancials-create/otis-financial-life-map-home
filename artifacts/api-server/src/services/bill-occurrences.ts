/**
 * Authoritative bill occurrence stepper — extracted from routes/forecast.ts
 * so cycle membership (cycle-processing / bill-cycle-sync) can share it
 * without a circular route→service→route import.
 *
 * The forecast engine, goal bucket derivation, card-cycle membership, and the
 * client-side form preview must all agree with this stepper. An unknown
 * frequency THROWS; it must never silently fall back to monthly (that failure
 * mode produced a silent 6×/12× over-forecast).
 */

// Adds months to a YYYY-MM-DD string, clamping the day to the target month's
// length so month-end dates (e.g. Jan 31 + 1mo) never overflow into a later month.
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, daysInTarget));
  return base.toISOString().slice(0, 10);
}

// Returns a YYYY-MM-DD string for the given year / 1-based month, clamping the
// day to the month's length so e.g. day 31 in April becomes the 30th and day 31
// in February becomes the 28th/29th (never skipped, never overflowed).
export function clampDay(year: number, month1: number, day: number): string {
  const daysInMonth = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const d = Math.min(Math.max(day, 1), daysInMonth);
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Adds n calendar days to a YYYY-MM-DD string (UTC, no timezone shift).
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type BillLike = {
  id?: number;
  frequency: string;
  dueDay: number;
  startDate: string | null;
  endDate: string | null;
  customIntervalDays?: number | null;
};

// Semi-monthly anchor semantics: occurrences land on the 1st and the 15th —
// identical to the pay schedule stepper (advanceByFrequency), NOT "add 15
// days". From any date: day < 15 → the 15th of the same month; otherwise the
// 1st of the next month.
export function stepSemiMonthlyIso(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (d < 15) return `${iso.slice(0, 8)}15`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

// Produces every occurrence date (YYYY-MM-DD) for a bill within the window
// [todayStr, windowEndStr], honoring the bill's own start/end dates.
//
//   - monthly           → anchored on dueDay, clamped to each month's length
//   - weekly / biweekly → stepped in days from the first bill date (startDate)
//   - semi-monthly      → anchored to the 1st and 15th (pay schedule semantics)
//   - quarterly         → stepped +3 months from the first bill date
//   - semi-annual       → stepped +6 months from the first bill date
//   - annual            → stepped +12 months from the first bill date
//   - custom            → stepped +customIntervalDays days from the first bill date
//
// The same start/end-date clamping applies to every frequency, so a bill never
// generates rows before its start date or after its end date.
export function generateBillOccurrences(
  bill: BillLike,
  todayStr: string,
  windowEndStr: string,
): string[] {
  const freq = bill.frequency.toLowerCase();

  // Clamp the generation window to the bill's own start/end dates.
  const startBoundary =
    bill.startDate && bill.startDate > todayStr ? bill.startDate : todayStr;
  const endBoundary =
    bill.endDate && bill.endDate < windowEndStr ? bill.endDate : windowEndStr;
  if (startBoundary > endBoundary) return [];

  const out: string[] = [];
  const MAX = 2000; // safety guard against pathological inputs

  if (freq === "monthly") {
    let y = Number(startBoundary.slice(0, 4));
    let m = Number(startBoundary.slice(5, 7));
    for (let i = 0; i < MAX; i++) {
      const occ = clampDay(y, m, bill.dueDay);
      if (occ > endBoundary) break;
      if (occ >= startBoundary) out.push(occ);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Date-driven frequencies. Seed from the first bill date when set; otherwise
  // fall back to dueDay in today's month for legacy rows without a start date.
  const seed =
    bill.startDate ??
    clampDay(Number(todayStr.slice(0, 4)), Number(todayStr.slice(5, 7)), bill.dueDay);

  const step = (iso: string): string => {
    switch (freq) {
      case "weekly": return addDaysIso(iso, 7);
      case "biweekly": case "bi-weekly": return addDaysIso(iso, 14);
      case "semi-monthly": case "semimonthly": return stepSemiMonthlyIso(iso);
      case "quarterly": return addMonthsIso(iso, 3);
      case "semi-annual": case "semiannual": case "biannual": return addMonthsIso(iso, 6);
      case "annual": case "annually": case "yearly": return addMonthsIso(iso, 12);
      case "custom": {
        const days = bill.customIntervalDays;
        if (days == null || days < 1) {
          throw new Error(`generateBillOccurrences: bill ${bill.id ?? "?"} has frequency "custom" but no valid customIntervalDays (${days})`);
        }
        return addDaysIso(iso, days);
      }
      default:
        throw new Error(`generateBillOccurrences: unknown frequency "${bill.frequency}" on bill ${bill.id ?? "?"} — refusing to guess a cadence`);
    }
  };

  let current = seed;
  let guard = 0;
  while (current < startBoundary && guard++ < MAX) current = step(current);
  if (guard >= MAX) {
    // Loud, never silent: a tripped guard means truncated emission (e.g. a
    // year-0026 start-date typo). The rows that fit are still returned.
    console.error(`generateBillOccurrences: loop guard tripped catching up bill ${bill.id ?? "?"} (freq=${bill.frequency}, start=${bill.startDate}) to ${startBoundary} — emission may be truncated`);
  }
  guard = 0;
  while (current <= endBoundary && guard++ < MAX) {
    out.push(current);
    current = step(current);
  }
  if (guard >= MAX && current <= endBoundary) {
    console.error(`generateBillOccurrences: loop guard tripped emitting bill ${bill.id ?? "?"} (freq=${bill.frequency}) — emission truncated at ${out[out.length - 1]} before window end ${endBoundary}`);
  }
  return out;
}
