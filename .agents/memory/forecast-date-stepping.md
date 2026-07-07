---
name: Forecast date stepping
description: Month-stepping and same-day boundary rules for recurring/spread forecast generation
---

Recurring/spread forecast generation must step months with **day-clamping** and compare
dates as **YYYY-MM-DD strings**, not JS Date objects.

**Why:** `Date.setMonth(m+1)` on month-end dates (e.g. Jan 31) overflows into a later
month (Mar 2/3), silently dropping or misplacing installments. And comparing an
event's midnight Date against `new Date()` (current time) drops same-day occurrences
after midnight has passed.

**How to apply:** For life-event (and any similar) generation in
`artifacts/api-server/src/routes/forecast.ts` and its mirror in `scripts/src/seed.ts`,
use the local helpers `toLocalIso`, `addMonthsIso` (clamps day to target month length),
and `advanceIsoByFrequency`. Compare `current >= todayStr && current <= endStr` as strings.
The older `advanceByFrequency(Date, freq)` used by bills/pay schedules still has the raw
setMonth behavior — leave it unless bills show the same bug.
