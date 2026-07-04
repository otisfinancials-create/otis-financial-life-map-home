---
name: Loans amortization parity
description: The loan amortization engine is duplicated on server and client; they must stay in sync.
---

The amortization calculation exists in two places and MUST produce identical results:
- Server: `computeAmortization` in `artifacts/api-server/src/routes/loans.ts` (source of truth for the `/loans/{id}/amortization` endpoint and the summary payoff dates).
- Client: `computeAmortization` in `artifacts/otis/src/components/loans/amortization.ts` (powers the real-time extra-payment simulator and per-loan payoff dates on the cards, without extra API calls).

**Why:** The simulator needs instant recomputation as the user types an extra payment, so the formula is replicated client-side rather than round-tripping. If the two drift, the simulator baseline won't match the server schedule shown in the same view.

**How to apply:** Any change to the interest/principal split, `round2` behavior, `addMonths` date logic, or the non-amortizing/zero-balance guards must be applied to BOTH files in lockstep.
