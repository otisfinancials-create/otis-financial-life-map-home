---
name: Goals plan/commit lifecycle
description: How goals ride the bill machinery via billKind, and the invariants that keep the forecast conserved.
---

The goal lives in `goals`; a bill row (billKind='goal_contribution') is a *consequence* of committing, never the goal itself.

Rules:
- Destination account must be OUTSIDE the forecast pool (is_forecast_account=false), source inside — otherwise both transfer legs cancel and the goal is invisible. Validated at create/update AND re-validated at commit.
- monthlyContribution = (target − alreadySaved) ÷ wholeMonths, rounded UP to nearest $5, cent-safe (exact $500 must not become $505; use epsilon before ceil).
- alreadySaved never creates a forecast row (already in the anchored balance).
- Uncommit: no reconciled rows → delete bill + planned forecast rows; any reconciled → endDate=today + isActive=false. NEVER the generic bills DELETE path (lossy: detaches cycle allocations to catch-all).
- Generic bills PATCH/DELETE reject goal_contribution bills; Bills UI blocks editing them (toast → Goals page).
- Commit is claim-first (conditional status update in a transaction) to prevent duplicate bills under concurrent commits.
- Exclusions: populateCycleBills and bill-detection's reconcileAgainstBills filter billKind='regular'.

**Why:** conservation — commit must drop the ending balance by exactly contribution × occurrences and uncommit must restore it to the cent; verified 2026-08-01.
**How to apply:** any new consumer of billsTable (budgets, surplus, detection, cycles) must decide explicitly how it treats billKind != 'regular'. Never run a balance sync while verifying goal math — it papers over errors with an adjustment row.
