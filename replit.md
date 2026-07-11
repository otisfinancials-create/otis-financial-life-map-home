# Otis — Financial Life Map

[![CI](https://github.com/otisfinancials-create/otis-financial-life-map/actions/workflows/ci.yml/badge.svg)](https://github.com/otisfinancials-create/otis-financial-life-map/actions/workflows/ci.yml)

A personal finance web app for high-earning households. Combines cash flow forecasting, net worth tracking, bill management, investment monitoring, and life event planning into a single, beautifully designed dashboard.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/otis run dev` — run the Otis frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS + wouter (routing)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Charts: Recharts
- Forms: react-hook-form + zod

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle ORM table definitions (bills, pay_schedules, accounts, forecasted_transactions)
- `artifacts/api-server/src/routes/` — Express route handlers (bills, accounts, pay_schedules, forecast, dashboard, subscribe)
- `artifacts/api-server/src/routes/subscribe.ts` — public (pre-`requireAuth`) `POST /api/subscribe` that adds an email to the Mailchimp audience (used by the Coming Soon page). Reads `MAILCHIMP_API_KEY` + `MAILCHIMP_AUDIENCE_ID`; returns JSON `{ status: "subscribed" | "already" | "invalid_email" | "error" }`.
- `artifacts/otis/src/` — React frontend (pages, components, layout)
- `artifacts/coming-soon/` — standalone static "Coming Soon" landing page (self-contained `index.html`, no React; served at the root `/`). This is the public face of the deployment while the main app is not yet launched.
- Routing note: the main Otis app is served at `/app/` (BASE_PATH `/app/`); the Coming Soon page owns the root `/`; the API server is at `/api`. To make the main app public at the root later, swap the `paths`/`previewPath`/`BASE_PATH` back in the two `artifact.toml` files via `verifyAndReplaceArtifactToml`.
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas for server validation (do not edit)

## Architecture decisions

- Contract-first: OpenAPI spec gates codegen which gates both frontend hooks and server Zod validators.
- Auth: Replit-managed Clerk. Web uses cookie-based sessions (no Bearer tokens in browser code). API routes protected via `requireAuth` middleware (`artifacts/api-server/src/middlewares/requireAuth.ts`). Health endpoint (`/healthz`) is public.
- Light mode default: CSS variables in `index.css` `:root` use a clean white/light-gray palette. `.dark` class retains the original dark values for potential future toggle.
- Forecast engine: `/api/forecast/regenerate` generates 12 months of transactions from bills + pay schedules on demand.
- Plaid not integrated yet — accounts are manually managed.

## Product

- **Dashboard** — net worth, monthly cash flow chart, upcoming bills, account summary
- **Bills** — full CRUD for recurring bills with categories, frequency, due day, active/inactive
- **Accounts** — financial accounts grouped by type (checking, savings, investment, retirement, loan)
- **Forecast** — 12-month cash flow projection by month, per-transaction ledger
- **Life Events** — full CRUD for major milestones (Pets, Vacations, Home Improvements, Education, Celebrations, Vehicle, Medical, Custom) with timing (one-time / spread-over-months / recurring), priority (Must Do / Planning To / Just Dreaming), and notes. Costs flow into the forecast as `forecasted_transactions` marked with `sourceLifeEventId` (shown in teal). Dashboard has an "Upcoming Life Events" widget and life-event costs are stacked as a distinct teal series on the Cash Flow Trend chart.
- **Loans** — placeholder (coming soon)
- **Otis AI** — AI assistant persona placeholder (Claude integration coming soon)

## Enhancements backlog (planned, not yet built)

- **Actual Balance Sync** (Forecast page) — reconcile forecasted running balance against the real bank balance. Spec: `attached_assets/Pasted-Add-this-to-your-enhancements-list-and-I-ll-include-it-_1783807742393.txt`. Summary: "Sync Balance" button in the Forecast controls bar opens a modal (actual balance + as-of date, defaults today); computes variance = actual − forecasted for that date; shows on-track/higher/lower message; inserts a one-time "Balance Adjustment (Synced [date])" row into `forecasted_transactions` so the running balance rebaselines forward; new `balance_syncs` table (id, user_id, sync_date, forecasted_balance, actual_balance, variance, created_at); "Last synced" note below the button; adjustment rows styled distinctly in blue with a sync icon (use a lucide icon, not the emoji from the spec, per no-emoji preference).

## User preferences

- Light mode as default
- "Bloomberg meets Notion" aesthetic — data-dense but never cluttered
- Do not use emojis in the UI
- AI assistant persona named "Otis"

## Gotchas

- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before touching routes or frontend hooks.
- After any DB schema change in `lib/db/src/schema/`, run `pnpm --filter @workspace/db run push`.
- Never call `pnpm dev` at workspace root — use `restart_workflow` or per-package `dev` scripts.
- Numeric columns from Drizzle (numeric/decimal) come back as strings — always `parseFloat(String(value))` before returning in API responses.
- `date` columns use `mode: "string"` (YYYY-MM-DD) to avoid timezone shifts.
- Forecast regeneration deletes all non-actual forecasted transactions and rebuilds from bills + pay schedules.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
