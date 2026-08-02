---
name: Loan–account explicit link
description: How linked loans and the single net-worth service interact; the retired dedupe heuristic.
---

- `services/net-worth.ts` (api-server) is the ONLY liabilities/net-worth computation — dashboard summary, /assets/summary, otis AI context, and the client NetWorthModal all follow its rule. Never re-derive the split.
- Rule: liability accounts |bal| + manual liability rows + loans with `account_id IS NULL`. The explicit link is the only dedupe; the name/payment heuristic (`financial-dedup.ts dedupedLoans`) is retired from totals and lives on only in GET /loans/link-suggestions (suggestion-only, never auto-link).
- Linked loans store `current_balance = NULL` — the account owns the balance; link PATCH clears it, unlink restores one (body value → prior value → account balance). `effectiveBalance` prefers the account whenever linked, even over a stale stored number.
- **Why:** a stored-but-ignored balance eventually gets read by something (review caught /loans/summary doing exactly that).
- **How to apply:** any new consumer of loan balances must go through `effectiveBalance` (server) or fall back to the linked account's balance (client), and any new totals endpoint must call `computeNetWorth`.
