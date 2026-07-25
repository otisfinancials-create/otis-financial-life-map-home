---
name: Forecast cycle payments
description: How card-cycle payment rows integrate into forecast regeneration without duplication
---
Cycle-backed cards (accounts with card_cycles rows) contribute ONE forecast row per cycle on its due_date (sourceCardCycleId + ccBasis 'actual' closed / 'projected' open = max(accumulated, planned)); their card-paid bills emit NO standalone or legacy-grouped lines.

**Why:** regeneration preserves isActual/isCommitted rows, so any derived row type that regen re-inserts must (a) be blocked from user edits/mark-paid server-side and (b) dedupe against survivors by its source id — otherwise mark-paid + regen duplicates the payment and double-counts.

**How to apply:** when adding any new derived/engine-owned forecast row kind, add a PATCH guard on its source column, skip re-insert when a survivor with that source id exists, and keep recomputeCcParent/child-sum logic away from it (isNull(sourceCardCycleId) guards). /forecast/monthly counts isCcParent only when sourceCardCycleId != null. Open-cycle projections read planned_total, which is 0 until processCycle runs on that cycle — process future cycles or the forecast shows $0.
