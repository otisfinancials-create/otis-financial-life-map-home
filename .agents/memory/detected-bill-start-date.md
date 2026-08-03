---
name: Detected bill start_date
description: Why detected bills must use first observed occurrence as start_date, never the next expected date.
---

- A bill confirmed from detection must get `start_date = detection first_seen` (the FIRST OBSERVED occurrence) or NULL — never `next_expected_date`.
- **Why:** cycle membership is occurrence-based and monthly membership checks `start_date <= cycle_end`. A future start_date silently excluded long-running bills from the in-flight card cycle, so their already-posted charges landed in the Misc catch-all envelope instead of bill allocations (correct total, wrong bucket — 2026-08 incident, cycle 79).
- NULL start_date is safe for monthly bills (occurrences anchor on due_day, membership treats NULL as "live"); non-monthly (quarterly/semi-annual/weekly) genuinely need a real observed date as the stepper's phase anchor.
- **How to apply:** any path that creates a bill from observed history (detection confirm, imports) must anchor start_date in the observed past. Repairing a wrong start_date is: update the date, then reprocess the card's open cycles (processCycle is idempotent; auto allocations re-target from Misc to the bill via the plaid_txn upsert).
- Cycle UI: card-composition rows show per-bill "paid" (status hit, actual amount) vs "not yet charged" (pending).
