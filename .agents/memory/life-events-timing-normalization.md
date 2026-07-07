---
name: Life events timing normalization
description: Server must clear non-applicable date/frequency fields when timing type changes
---

Life events have a `timingType` (one_time | spread | recurring) with different
applicable date fields. On create AND update the server normalizes fields via
`normalizeTimingFields` in `artifacts/api-server/src/routes/life_events.ts`.

**Why:** PATCH is partial and only updates provided keys. The dialog omits
non-applicable fields (sends undefined, which drops from JSON), so switching timing
type (e.g. one_time -> recurring) would otherwise leave a stale `eventDate` in the DB.
Upcoming-event UI reads `eventDate || startDate`, so stale dates corrupt ordering/display.

**How to apply:** PATCH fetches the existing row, merges the patch, and normalizes on the
**final** timing type — clearing eventDate for spread/recurring, startDate/endDate/frequency
for one_time, frequency for spread. Any new partial-update path for timing-typed records
must do the same merge-then-normalize.
