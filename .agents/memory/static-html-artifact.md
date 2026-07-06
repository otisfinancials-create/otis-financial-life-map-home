---
name: Static HTML page as a react-vite artifact
description: How to serve a plain self-contained HTML page when the only static artifact type is react-vite.
---

There is no plain-HTML artifact type; the static-serving option is `react-vite` (production serve = static). To host a single self-contained HTML page (inline CSS/JS, no React):

- Replace the scaffold `index.html` with the page and remove the `<script type="module" src="/src/main.tsx">` so Vite serves/builds it as a pure static page. Vite only bundles what `index.html` references, so with no module script the build just emits the HTML + `public/`.
- **You must also strip the scaffold**, or the leaf `typecheck` fails: delete `src/` and `components.json`, trim `package.json` to `vite` + `@replit/*` dev plugins + `@types/node`, remove the react/tailwind plugins from `vite.config.ts`, and point `tsconfig.json` `include` at just `["vite.config.ts"]` (empty `include` makes tsc error "no inputs").
- **Path-safe assets:** the artifact mounts under its `previewPath` (e.g. `/coming-soon/`). Use relative asset hrefs (`./favicon.svg`), never root-absolute (`/favicon.svg`) — root-absolute escapes the mount in production. Vite rewrites `./favicon.svg` to `<base>favicon.svg`.

**Why:** the react-vite scaffold ships a full shadcn/React tree whose typecheck can fail on its own (e.g. radix CSS-var types in `calendar.tsx`); keeping it around for a static page is dead weight and breaks validation.
