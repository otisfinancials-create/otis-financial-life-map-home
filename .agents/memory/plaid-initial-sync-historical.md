---
name: Plaid initial sync must wait for HISTORICAL_UPDATE_COMPLETE
description: Why a freshly linked Plaid item can end up with a cursor that permanently skips all history
---

On a brand-new Plaid item, `/transactions/sync` can return `has_more: false` with an empty batch *before* Plaid's historical backfill finishes. If you persist that `next_cursor`, every future sync reports zero added/modified/removed forever — the item looks "synced" (`last_synced_at` updates) but has no transactions and stale balances.

**Why:** This happened in production: a Wells Fargo item linked while the initial pull briefly failed saved a pre-history cursor; 93 transactions were invisible until the cursor was nulled and re-synced.

**How to apply:**
- On initial sync (no stored cursor), keep polling until `transactions_update_status === "HISTORICAL_UPDATE_COMPLETE"` (bounded attempts); if it never completes, return WITHOUT saving the cursor so the next run retries from scratch.
- Diagnosis pattern: call `transactionsSync` with no cursor from a throwaway script — it's read-only w.r.t. the stored cursor (a separate cursor stream).
- Fix pattern for a stuck item: set `transactions_cursor = NULL` and re-run the sync; upserts are idempotent.
- Related: items link with `webhook: ""` — no webhook registered, so no HISTORICAL_UPDATE/SYNC_UPDATES_AVAILABLE notifications; only scheduled/manual syncs pick up data.
