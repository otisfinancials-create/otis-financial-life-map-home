---
name: Plaid webhook verification
description: Public Plaid webhook must verify the Plaid-Verification JWT and throttle per-item sync
---
Rule: any public Plaid webhook endpoint must (1) verify the `Plaid-Verification` ES256 JWT against keys from `/webhook_verification_key/get` (match `request_body_sha256` of the RAW body — capture via `express.json({verify})`), and (2) guard sync fan-out with a per-item in-flight lock + debounce.
**Why:** architect review failed the first pass — an unverified webhook lets anyone trigger unbounded Plaid API + DB work (cost/DoS) using stored access tokens.
**How to apply:** whenever adding webhook receivers that trigger expensive backend work, verify signatures before any DB lookup and never rely on obscurity of item ids.

## Status (2026-07-25)
Webhook is registered on all Plaid items at `https://$REPLIT_DEV_DOMAIN/api/plaid/webhook` (dev domain — items live in the dev DB; prod deployment has a separate DB, so registering the prod URL would hit an empty items table). `linkTokenCreate` derives the webhook from `REPLIT_DOMAINS`, so items linked in production auto-register the prod URL. ITEM webhooks (ITEM_LOGIN_REQUIRED / PENDING_EXPIRATION / PENDING_DISCONNECT) set `plaid_items.needs_reauth`; LOGIN_REPAIRED clears it. Known gap: last-write-wins ordering on ITEM state updates.
