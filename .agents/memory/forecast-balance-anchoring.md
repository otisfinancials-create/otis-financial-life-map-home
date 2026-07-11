---
name: Forecast balance anchoring & sync adjustments
description: How the Forecast ledger anchors the running balance and why balance-sync adjustment rows are special
---

The Forecast ledger anchors the running balance so today opens at the user's starting balance: past (7-day lookback) rows are back-filled by subtracting their net from the anchor. Anything included in that back-fill has zero effect on today/future balances.

**Rule:** balance-sync adjustment rows (`sourceBalanceSyncId` set) must be *excluded* from the past back-fill (frontend) and preserved by forecast regeneration and delete endpoints (server), or the rebaseline silently disappears.

**Why:** an adjustment represents a real-world reconciliation, not a projection — its whole purpose is to shift today/future balances by the variance.

**How to apply:** any server-side computation of "the balance the user sees on date D" must mirror the frontend anchoring math exactly (7-day window, adjustments carried through the anchor). If the frontend anchoring or lookback window changes, the `/forecast/sync-balance` formula must change in lockstep.
