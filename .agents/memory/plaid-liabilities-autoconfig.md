---
name: Plaid Liabilities auto-config
description: Card liability data sync, cycle-day auto-fill rules, and the statement-seam forecast row.
---

# Plaid Liabilities auto-config

- `syncLiabilitiesForItem` (api-server services) stores min payment / last statement balance / next due date / APR on accounts and auto-fills `statement_day`+`due_day` ONLY when BOTH are NULL (race-safe `isNull` guards in the UPDATE's WHERE), then calls `generateCyclesForAccount` (safe: REPLACE semantics keyed by statement period).
- **Why:** manual config must never be clobbered; cycle regeneration must never accumulate duplicates.
- It is best-effort BY CONTRACT — callers (token exchange, update-mode refresh, nightly sync) do not wrap it in try/catch; unsupported institutions (PRODUCTS_NOT_SUPPORTED etc.) and hard errors return `supported:false` instead of throwing. Always log Plaid errors through `sanitizeSyncError` — raw axios errors leak PLAID-CLIENT-ID/SECRET headers into logs.
- **Statement seam row:** a freshly linked card's already-closed statement predates the first generated cycle, so forecast regenerate emits a one-off "<card> statement payment" row (amount = last_statement_balance, date = next_payment_due_date, `isCcParent=true`, `ccBasis='actual'`, `sourceCardCycleId=null`). Dedupe: skip if a cycle due date or a same-pass legacy ccGroup parent or a surviving row covers that card+date.
- **Discriminator:** legacy child-sum CC parents always have `ccBasis IS NULL`; `recomputeCcParent` filters on that, or it would zero the seam row (no children). `ccBasis` is a closed enum ('actual'|'projected') in the generated API schema — adding values requires openapi + codegen churn.
- `plaid_subtype` is written at link/refresh call sites only; pre-existing rows need an accountsGet backfill.
- **Fixed payment mode:** accounts.payment_mode 'full'|'fixed' (+fixed_payment_amount, payoff_target_date). `buildFixedPaymentSchedule` (exported from routes/forecast.ts) is the single source of truth for the payoff schedule (seam date + cycle dues + monthly extension, final payment = remainder); the payment-mode endpoint MUST use it for projections or they drift from emitted rows. Cycle rows add the fixed portion ON TOP of new charges. Conservation invariant: portions sum exactly to last_statement_balance.
- Suggestion prompt (last_payment_amount < 50% of last_statement_balance, not dismissed, mode full) — accept/dismiss endpoints; never silently switch modes. aprs jsonb stores the full Plaid array; a 'special' entry = promo financing.
- Account dialog serializes cycle-config → payment-mode saves (both regenerate the forecast; racing them is last-write-wins).
- Card-only institutions skip the forecast-accounts selection dialog; the Accounts page banner (unconfigured cards) + post-link handoff (`onLinkedCardsNeedSetup`) are the fallback when Liabilities can't auto-configure.
