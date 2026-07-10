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

**How to apply:** All recurring generation (life events AND bills) must use ISO-string
date math with day-clamping and string comparison (`current >= todayStr && current <= endStr`).
Bill occurrence generation is a pure function that honors each bill's own start/end dates and
frequency, clamping the due day to each target month's length.

**Bill `dueDay` for non-monthly frequencies:** `dueDay` is a not-null column, but for
weekly/biweekly/quarterly/annual bills the real cadence is anchored by the bill's start date,
not `dueDay`. Derive `dueDay` from the start date's day-of-month **server-side** on create/update
(not only in the form) so `/bills/upcoming` and due-day displays stay consistent no matter how the
bill is written. Forecast generation itself uses the start date for non-monthly bills, so it is
already correct; the canonicalization protects the other read paths.
