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
- `artifacts/otis/src/utils/categoryIcons.ts` — shared category visual system: `CATEGORY_META`, `categoryMeta()`, `categoryDisplayLabel()`, `ACCOUNT_TYPE_META`, `ICON_STROKE`, plus `CATEGORY_EMOJI` + `getCategoryEmoji(category, description?)` (lowercase substring match over category + description/bill name, insertion order wins, fallback 📋). Category icon CELLS render plain emoji (16px, lineHeight 1) in Forecast ledger rows, Bills rows, Dashboard Upcoming Bills, and Life Events cards/headers; Lucide icons remain for badges/colors, the Bills donut, and the By Account Type panel. Do not create per-page category icon/color maps.
- `artifacts/coming-soon/` — standalone static "Coming Soon" landing page (self-contained `index.html`, no React; served at the root `/`). This is the public face of the deployment while the main app is not yet launched.
- Routing note: the main Otis app is served at `/app/` (BASE_PATH `/app/`); the Coming Soon page owns the root `/`; the API server is at `/api`. To make the main app public at the root later, swap the `paths`/`previewPath`/`BASE_PATH` back in the two `artifact.toml` files via `verifyAndReplaceArtifactToml`.
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas for server validation (do not edit)

## Architecture decisions

- Contract-first: OpenAPI spec gates codegen which gates both frontend hooks and server Zod validators.
- UI palette (Jul 2026 overhaul): Carolina blue `#56A0D3` (primary/accents) + navy `#0D2B45` (text, active states) with light gray page bg; brand vars `--color-navy`/`--color-carolina`/etc in `index.css` `:root`, shadcn HSL vars remapped to match; Nunito font. Semantic money colors preserved (green #059669 positive, red #dc2626 negative) — only accents are carolina. Sidebar (220px, `--sidebar-width`): soft-gray logo area with SVG "otis" wordmark, sectioned nav (PLANNING/ACCOUNTS/LIFE/INTELLIGENCE), navy active pill, "Ask Otis" button → /otis, user initials avatar + "Personal plan" + sign-out at bottom. Topbar: white bar with "Welcome back, [name]" greeting + tagline.
- Auth: Replit-managed Clerk. Web uses cookie-based sessions (no Bearer tokens in browser code). API routes protected via `requireAuth` middleware (`artifacts/api-server/src/middlewares/requireAuth.ts`). Health endpoint (`/healthz`) is public.
- Light mode default: CSS variables in `index.css` `:root` use a clean white/light-gray palette. `.dark` class retains the original dark values for potential future toggle.
- Forecast engine: `/api/forecast/regenerate` generates 12 months of transactions from bills + pay schedules on demand.
- Plaid not integrated yet — accounts are manually managed.

## Product

- **Dashboard** (redesigned Jul 2026) — three rows: (1) 4 stat cards (Net Worth, Monthly Cash Flow, Total Liabilities, Bills This Month); (2) "Upcoming Forecast" (next 8 rows with client-side running balance — simplified version of the forecast anchor algorithm: latest balance-override ≤ today anchors, else startingBalance-as-of-today rewinds past net; TODAY row amber, negative balances red) beside "Bills Due Soon" (urgency dots: red ≤3d, amber ≤7d); (3) "Monthly Snapshot" 2×2 mini stats (Bills Paid/Remaining, Days To Paycheck, Critical Bills) beside "Retirement Progress" (balance, carolina progress bar, readiness %, projected value, monthly contribution). Also keeps monthly cash flow chart and "Connected Accounts" panel (negatives first by abs value). Net Worth / Monthly Cash Flow / Total Liabilities metric cards open breakdown modals (`components/dashboard/breakdown-modals.tsx`) instead of navigating; their loan dedup mirrors the server rule in `financial-dedup.ts` (name OR monthly-payment match vs liability accounts). Net worth & total liabilities include deduped Loan balances everywhere (dashboard + Otis context). Upcoming Bills rows deep-link to `/forecast?txdate=&txdesc=` which scrolls to and yellow-flashes the row.
- **Bills** — page titled "Bills"; full CRUD for recurring bills with categories (incl. Pets), frequency, due day, active/inactive. Loans auto-sync: creating/editing a loan auto-creates a "[Loan Name] Payment" bill (category Debt Payments) unless a matching bill exists (`loanMatchesBill` in `artifacts/api-server/src/lib/financial-dedup.ts`); loan POST/PATCH responses carry `billSync` for the toast.
- **Accounts** — page shows full-width Total Assets / Total Liabilities summary cards with individual account cards stacked beneath (institution, type badge, balance, disabled "Connect via Plaid" placeholder). Retirement-type accounts have a `monthlyContribution` field (summed into retirement projections).
- **Otis AI chat** — assistant bubbles render react-markdown; chat state persists across SPA navigation in a module store (cleared by "Start New Conversation"); last 20 DB messages (`otis_conversations`) load on first open with >30-min date dividers and are merged into Claude calls server-side; net-worth/cash-flow answers are DB-cached (`otis_response_cache`, invalidated by the middleware in `routes/index.ts` on data writes) and show an "as of [time]" caption via the `cachedAsOf` SSE event; extra-payment loan math is computed server-side (deterministic closed-form) and passed to Claude as exact facts; client sends last 20 messages. Tagline: "Your non-judgmental best friend, always at your side".
- **Mobile** — below 768px the sidebar collapses to a hamburger (Topbar Menu button → shadcn Sheet overlay via `SidebarContent`); wide forecast tables scroll horizontally.
- **Retirement** — retiring-today (age == current age) shows current balance message; $0/no goal = 100% readiness; chart line labeled "Current Assumptions"; What-If panel has "Reset to Current Assumptions".
- **Forecast** — 12-month cash flow projection by month, per-transaction ledger with a 30-day lookback (older rows are archived out of view but kept in the DB).
  - **Balance Updates (overrides)**: "Update Current Balance" modal (balance + as-of date, restricted to the last 30 days). The server inserts/replaces a "Balance Update — [date]" row (`sourceBalanceSyncId` set, one per date); the row's amount IS the running balance at that point and all later rows recalculate forward from it (client-side anchor algorithm in `forecast.tsx` `txsWithBalance`; earlier/later overrides re-anchor). Override rows are sky-blue, not editable/deletable/draggable, excluded from monthly income/expense totals, and survive regeneration. History in `balance_syncs`.
  - **Row status**: `status` column (`missed` or null). Missed rows show strikethrough + orange badge and contribute $0 to balances and totals; undo via RotateCcw action. Marking paid clears status. Future rows cannot be marked paid (blocked with an explainer dialog, TC-F12); the "Current Balance" marker only ever sits on rows dated ≤ today.
  - **Full row editing**: clicking a row opens an edit sheet (date, description ≤100 chars with counter, category, type, amount, notes, Paid switch disabled for future dates). Editing a recurring bill/paycheck row prompts "just this one vs all future occurrences" (`applyToFuture` on PATCH). First amount deviation snapshots `forecastedAmount` so paid rows show a "vs planned" variance.
  - **Export**: Export dropdown — CSV, Excel (.xlsx via lazy-loaded `xlsx`), or tab-separated clipboard copy; respects active filters. Columns: Date, Description, Category, Type, Amount (signed; overrides show balance value), Running Balance.
  - **Monthly Summary view** is derived directly from the ledger month groups, so Income/Expenses/Net/End Balance always match the Ledger view.
  - **Ledger redesign (Jul 2026)**: all ledger rows/headers share one CSS grid (`LEDGER_GRID`); per-category color bar/icon/badge via the shared category icon system; pill controls (navy time range, teal view toggle, navy "Hide/Show history" toggle that hides pre-today rows from the ledger display only); status pills; month headers are clean centered dividers (no In/Out totals); TODAY divider bar shows current balance (visible whether or not history is hidden); balance-override rows display as "Balance updated · Jul 11" (raw description stays "Balance Update — YYYY-MM-DD" in DB/exports); category legend + 4-column totals footer (footer totals track the time range only, ignoring search/category filters). Derived "Otis insight" rows per month (negative balance dip, 3+ bills ≥$500 in a 7-day window, life-event spend ≥$1000) link to `/otis?prompt=…`; the Otis page consumes `?prompt=` on mount to prefill the chat.
- **Life Events** — full CRUD for major milestones (Pets, Vacations, Home Improvements, Education, Celebrations, Vehicle, Medical, Custom) with timing (one-time / spread-over-months / recurring incl. biannually + custom-days interval via `customIntervalDays`), priority ("Must Do" / "Maybe, Someday" — value `planning_to`; legacy `just_dreaming` displays/groups as Maybe, Someday), and notes. One-time events must be dated in the future. Page layout: two columns (Must Do | Maybe, Someday) sorted by date. Costs flow into the forecast as `forecasted_transactions` marked with `sourceLifeEventId` (shown in teal). Dashboard has an "Upcoming Life Events" widget and life-event costs are stacked as a distinct teal series on the Cash Flow Trend chart.
- **Loans** — loan CRUD with amortization schedule (client-side CSV export with BOM), "Model a Loan 🤖" button → `/otis?prompt=…`, and auto bill sync (see Bills).
- **Otis AI** — AI chat assistant with an animated avatar (`artifacts/otis/src/components/OtisAvatar.tsx`): yellow-Lab photo (`artifacts/otis/public/images/otis-avatar.png`), states idle/thinking/talking/listening (spring tilt, pulsing teal ring for thinking/listening, solid navy ring + speech bubble for talking), sizes sm 48px static / md 120px chat header / lg 220px page hero (160px mobile). Page-load greeting and scenario/chat lifecycle drive the state. Sidebar Otis link uses a 28px avatar with a teal glow when active.

## Enhancements backlog (planned, not yet built)

- (empty)

## User preferences

- Light mode as default
- "Bloomberg meets Notion" aesthetic — data-dense but never cluttered
- Category icons are plain emoji characters (💼 🏠 🍽️ …) via the shared `getCategoryEmoji()`; elsewhere avoid decorative emojis in the UI
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
