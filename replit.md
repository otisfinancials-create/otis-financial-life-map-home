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
- `artifacts/api-server/src/routes/` — Express route handlers (bills, accounts, pay_schedules, forecast, dashboard)
- `artifacts/otis/src/` — React frontend (pages, components, layout)
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
- **Life Events** — placeholder (coming soon)
- **Loans** — placeholder (coming soon)
- **Otis AI** — AI assistant persona placeholder (Claude integration coming soon)

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
