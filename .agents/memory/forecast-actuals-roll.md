---
name: Forecast start date + actuals roll
description: How the anchored forecast past works — start date, anchor balance, unplanned buckets, missed marking — and its conservation invariant.
---

# Forecast start date + rolling actuals (P6 part 2)

**Invariant:** every posted bank transaction steps the running balance exactly once — via a reconciled planned row XOR an unplanned bucket XOR (temporarily) the planned row of a live reconcile candidate. Card charges never step cash directly; only the cycle payment row does, so posted CREDIT_CARD_PAYMENT transfers are excluded from the roll.

Key mechanics (service: actuals-roll on the api-server; anchor endpoint on the forecast routes):
- `user_settings.forecastStartDate` set ⇒ `startingBalance` means "balance AS OF that date" (anchored mode). Unset ⇒ legacy "balance at start of today" with 30-day lookback. Both server sync-balance math and the client running-balance math branch on this — change them in lockstep.
- Anchor reconstruction = current bank balance + Σ posted Plaid amounts over [start, today] (Plaid positive = outflow). Must be bounded above by today or future-dated records bias it.
- Forecast regeneration backfills planned bill/pay rows from the start date (delete window also extends back), so the roll can auto-reconcile or mark them missed. Missed rows are uncommitted and get re-derived on every regen — idempotent by design.
- Roll ordering matters: resolve stale planned rows FIRST, then re-derive reconcile candidates, then rebuild unplanned buckets excluding claimed + candidate txn ids. Reversing this double-counts.
- Rolls are per-user serialized via an in-process promise chain; regen, plaid sync, and reconcile routes all trigger them concurrently. Plaid sync must trigger the roll on removed-only deltas too (and even if bill detection fails), or stale unplanned rows survive.
- Unplanned rows (`isUnplanned`) are derived: PATCH/DELETE blocked server-side, edit sheet blocked client-side; rebuilt by delete-and-reinsert inside one transaction.

**Why:** ledger past previously showed only planned rows — unmatched posted spending vanished and past unpaid bills counted as-if-paid, producing large fake variance vs the real bank balance.
