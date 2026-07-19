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
- UI palette (Jul 2026 overhaul round 3 — "premium" spec): dark navy sidebar `#0A1628` (`--color-navy-dark`), Carolina blue `#56A0D3` active pill/accents, page bg `#F4F6F9`, card border `#e8ecf0`, surface `#f8fafc`, text secondary `#64748b` / muted `#94a3b8`; brand vars in `index.css` `:root`, shadcn HSL vars remapped; body 13px, h1 16px/h2 14px/h3 13px. Semantic money colors preserved (green #059669 positive, red #dc2626 negative). Sidebar (210px, position:fixed top/left 0 with 10px margins, 14px radius, height calc(100vh-20px); content wrapper offsets via `md:ml-[calc(var(--sidebar-width)+10px)]`, `md:ml-0` when collapsed): off-white `#F8F6F1` logo section with Georgia serif "Otis" text wordmark (no image) + 7px tagline; sectioned nav (PLANNING/ACCOUNTS/LIFE/INTELLIGENCE) with Carolina blue active pill; bottom = Help & Support + divider + user profile ONLY (no icon row). Topbar (Shell.tsx, md+ only): plain row on the gray page bg (no white card) with greeting + date left; "Pro plan" badge + search/bell/settings/sidebar-collapse 30px icon buttons right (collapse state lives in Shell). Page bg `#F4F6F9` is set explicitly on html/body/#root. Dashboard stat card primary values are always navy `#0D2B45` (no green/red on the big number). Mobile keeps floating hamburger → nav sheet. Cryptocurrency is a supported asset/account type (amber `#F59E0B`, Bitcoin icon, 🪙 emoji).
- Auth: Replit-managed Clerk. Web uses cookie-based sessions (no Bearer tokens in browser code). API routes protected via `requireAuth` middleware (`artifacts/api-server/src/middlewares/requireAuth.ts`). Health endpoint (`/healthz`) is public.
- Light mode default: CSS variables in `index.css` `:root` use a clean white/light-gray palette. `.dark` class retains the original dark values for potential future toggle.
- Forecast engine: `/api/forecast/regenerate` generates 12 months of transactions from bills + pay schedules on demand.
- Plaid not integrated yet — accounts are manually managed.

## Product

- **Dashboard** (Round 2, Jul 2026) — page title "Dashboard"; 4 stat pills (Net Worth, Average Monthly Cash Flow, Savings & Investments, Bills Snapshot) all opening breakdown modals (`components/dashboard/breakdown-modals.tsx`); "6 Month View" stacked area chart (income vs expenses vs life events) replacing the old cash flow chart; Retirement Progress panel; "Connected Accounts" panel (negatives first by abs value). Upcoming Forecast / Bills Due Soon / Monthly Snapshot rows were removed. Modal loan dedup mirrors the server rule in `financial-dedup.ts` (name OR monthly-payment match vs liability accounts). Net worth & total liabilities include deduped Loan balances everywhere (dashboard + Otis context).
- **Bills** — page titled "Bills" with three tabs [Bills | Planned vs Actual | Budget] (header subtitle changes per tab; search/Add Bill controls show on Bills tab only). Bills tab: full CRUD for recurring bills with categories (incl. Pets, Cell Phone), frequency, due day, active/inactive. Bills have an `amountType` (`positive`/`negative`, default negative) — positive bills generate income forecast rows and display green +$ in the list. "Auto-pay" payment method displays as "Bank Draft" (stored value stays `auto-pay`). Editing is a split-panel: clicking a row (or Edit) opens an inline right panel (list 60% / form 40%, X to close) using the shared `BillForm` (extracted from `bill-dialog.tsx`; Add Bill remains a dialog). Planned vs Actual tab (`components/bills/planned-vs-actual.tsx`): month navigator (any month), Planned/Paid/Remaining summary cards, INCOME row aggregating pay schedules (paid via forecast `sourcePayId`), expandable per-category bill rows with ✅/⚠️/🔴 status icons, totals row, Plaid note; CC parent rows excluded from paid sums; positive-amountType bills excluded. Budget tab (`components/bills/budget-tab.tsx`): normalized monthly view — Monthly Income / Monthly Bills / Net Cash Flow cards, income table with inline pay-amount editing (useUpdatePaySchedule), expandable bills-by-category table with % of income and inline bill amount editing (both regenerate forecast + invalidate forecast caches + confirmation toast), Total/Net rows, horizontal bar visual (Carolina income / red bills / green net). Loans auto-sync: creating/editing a loan auto-creates a "[Loan Name] Payment" bill (category Debt Payments) unless a matching bill exists (`loanMatchesBill` in `artifacts/api-server/src/lib/financial-dedup.ts`); loan POST/PATCH responses carry `billSync` for the toast.
- **Assets & Investments** — `/assets-investments` page (July 2026 merge of the old Assets and Savings & Investments pages; old routes redirect). Three summary cards (combined total, Manual Assets, Savings & Investments with MoM change from `GET /api/savings/summary` → `savings_snapshots`), "My Assets" section (manual asset CRUD grouped by type), "Savings & Investment Accounts" section (savings/investment/brokerage accounts only — no retirement) with per-account goals + Carolina-blue progress bar, and a net-worth contribution footer. Goals live in the `account_goals` table (unique per user+account) via `GET /api/account-goals` + `PUT /api/account-goals/{accountId}` (null goalAmount clears); the legacy `accounts.savingsGoal` column still exists but is no longer used by the UI (values were migrated). Sidebar shows "Pay" instead of "Pay schedules" (display only — routes/DB unchanged).
- **Accounts** — page shows full-width Total Assets / Total Liabilities summary cards with individual account cards stacked beneath (institution, type badge, balance, disabled "Connect via Plaid" placeholder). Retirement-type accounts have a `monthlyContribution` field (summed into retirement projections). Credit-card accounts have a "Credit Card Billing Cycle" section (3 day-of-month ints: `ccCycleStartDate`, `ccCycleEndDate`, `ccPaymentDueDate`) that powers forecast CC grouping.
- **Credit-card grouping (forecast engine)** — bills with `paymentMethod = "credit-card:<Card Name>"` (case-insensitive match to a credit_card account with all 3 cycle fields set) are grouped in the forecast: child rows land on the card's payment due date (cycle end on/after occurrence, then due day strictly after) under a "Credit Card Payment — <Card>" parent row (`ccAccountId` + `isCcParent` on `forecasted_transactions`). The parent's amount is ALWAYS the sum of its PAID (isActual, non-missed) children — recomputed deterministically (`recomputeCcParent` in `routes/forecast.ts`) on any child PATCH/DELETE; regeneration preserves paid children, skips duplicate occurrences, and recreates parents with the paid sum. Children contribute $0 to running balance/totals/export; only the parent hits cash. Deleting a parent deletes its children. Monthly endpoint skips parent rows.
- **Budget** — merged into the Bills page as a tab (Jul 2026). `/budget` redirects to `/bills`; no sidebar item.
- **Goals** — `/goals` placeholder page (coming soon).
- **Otis AI chat** — assistant bubbles render react-markdown; chat state persists across SPA navigation in a module store (cleared by "Start New Conversation"); last 20 DB messages (`otis_conversations`) load on first open with >30-min date dividers and are merged into Claude calls server-side; net-worth/cash-flow answers are DB-cached (`otis_response_cache`, invalidated by the middleware in `routes/index.ts` on data writes) and show an "as of [time]" caption via the `cachedAsOf` SSE event; extra-payment loan math is computed server-side (deterministic closed-form) and passed to Claude as exact facts; client sends last 20 messages. Tagline: "Your non-judgmental best friend, always at your side".
- **Mobile** — below 768px the sidebar collapses to a hamburger (Topbar Menu button → shadcn Sheet overlay via `SidebarContent`); wide forecast tables scroll horizontally.
- **Retirement** — retiring-today (age == current age) shows current balance message; $0/no goal = 100% readiness; chart line labeled "Current Assumptions"; What-If panel has "Reset to Current Assumptions".
- **Forecast** — 12-month cash flow projection by month, per-transaction ledger with a 30-day lookback (older rows are archived out of view but kept in the DB).
  - **Balance Updates (overrides)**: "Update Current Balance" modal (balance + as-of date, restricted to the last 30 days). The server inserts/replaces a "Balance Update — [date]" row (`sourceBalanceSyncId` set, one per date); the row's amount IS the running balance at that point and all later rows recalculate forward from it (client-side anchor algorithm in `forecast.tsx` `txsWithBalance`; earlier/later overrides re-anchor). Override rows are sky-blue, not editable/deletable/draggable, excluded from monthly income/expense totals, and survive regeneration. History in `balance_syncs`.
  - **Row status**: `status` column (`missed` or null). Missed rows show strikethrough + orange badge and contribute $0 to balances and totals; undo via RotateCcw action. Marking paid clears status. Future rows cannot be marked paid (blocked with an explainer dialog, TC-F12); the "Current Balance" marker only ever sits on rows dated ≤ today.
  - **Full row editing**: clicking a row opens an edit sheet (date, description ≤100 chars with counter, category, type, amount, notes, Paid switch disabled for future dates). Editing a recurring bill/paycheck row prompts "just this one vs all future occurrences" (`applyToFuture` on PATCH). First amount deviation snapshots `forecastedAmount` so paid rows show a "vs planned" variance.
  - **Export**: Export dropdown — CSV, Excel (.xlsx via lazy-loaded `xlsx`), or tab-separated clipboard copy; respects active filters. Columns: Date, Description, Category, Type, Amount (signed; overrides show balance value), Running Balance.
  - **Monthly Summary view** is derived directly from the ledger month groups, so Income/Expenses/Net/End Balance always match the Ledger view.
  - **Ledger redesign (Jul 2026)**: all ledger rows/headers share one CSS grid (`LEDGER_GRID`); per-category color bar/icon/badge via the shared category icon system; pill controls (navy time range, teal view toggle, navy "Hide/Show history" toggle that hides pre-today rows from the ledger display only); status pills; month headers are clean centered dividers (no In/Out totals); TODAY divider bar shows current balance (visible whether or not history is hidden); balance-override rows display as "Balance updated · Jul 11" (raw description stays "Balance Update — YYYY-MM-DD" in DB/exports); category legend. Round 2 (Jul 2026): the 4-box totals footer was removed; the page is a locked layout (`h-[calc(100vh-92px)]`, only the ledger scrolls); the per-row date column was replaced by group-by-day header rows; CC groups render as a collapsible parent ("Credit Card Payment — <Card>") with indented children (children excluded from running balance, totals, and export balance). Derived "Otis insight" rows per month (negative balance dip, 3+ bills ≥$500 in a 7-day window, life-event spend ≥$1000) link to `/otis?prompt=…`; the Otis page consumes `?prompt=` on mount to prefill the chat.
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
- After deploying the account_goals change, run `pnpm --filter @workspace/scripts run backfill-account-goals` against the target DB to copy legacy `accounts.savings_goal` values into `account_goals` (idempotent).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
