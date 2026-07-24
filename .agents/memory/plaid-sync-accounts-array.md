---
name: Plaid transactionsSync accounts array
description: When balance data is (and isn't) present in /transactions/sync responses
---

Plaid's `/transactions/sync` response includes `accounts[]`, but it is only populated when the sync run actually returned transaction updates. A fully caught-up cursor yields `accounts: []`, so anything reading balances from that array (daily balance snapshots) captures nothing on no-op runs.

**Why:** Verified live (Jul 2026) — three connected items, all caught up, all returned empty `accounts` arrays despite the field existing.

**How to apply:** Treat empty-accounts sync runs as expected, not a bug. RESOLVED (Jul 2026): the sync now calls `/accounts/get` after each transactionsSync run and snapshots every account's balance regardless of activity — `/accounts/get` returns cached balances and is free, unlike the paid `/accounts/balance/get`. The transactionsSync `accounts[]` array is only a fallback if `/accounts/get` fails.
