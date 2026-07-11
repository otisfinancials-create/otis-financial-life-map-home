---
name: Forecast balance anchoring & Balance Update overrides
description: How the Forecast ledger anchors the running balance and why Balance Update override rows are special
---

The Forecast ledger shows a 30-day lookback. Running balance anchors on the latest Balance Update override row (`sourceBalanceSyncId` set) dated ≤ today: that row's amount IS the balance at that point; later rows roll forward, earlier rows back-fill, and every other override (earlier, later, or future-dated) re-anchors the value. With no override, balance anchors so today ends at the user's starting balance (past net subtracted, then rolled forward).

**Rules:**
- Override rows must be excluded from monthly income/expense totals and from edit/delete/drag/reorder (guarded client AND server side — the reorder endpoint rejects ids containing overrides so they keep `sortOrder = -1` and stay first on their date).
- Missed rows (`status = 'missed'`) contribute $0 to balances and totals.
- Overrides must be preserved by forecast regeneration and delete endpoints, or the reconciliation silently disappears.
- One override per date: the sync endpoint inserts-or-replaces.

**Why:** an override represents a real-world reconciliation, not a projection — the user's stated balance must win over the computed one from that point forward.

**How to apply:** any server-side computation of "the balance the user sees on date D" must mirror the frontend anchoring math exactly (30-day window, override-anchor algorithm in `forecast.tsx` `txsWithBalance`). If the anchoring or lookback window changes, the sync endpoint must change in lockstep.
