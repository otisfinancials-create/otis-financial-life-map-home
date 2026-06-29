---
name: Otis light/dark theming
description: How light/dark mode is wired in the Otis web app and the gotcha that made the authenticated app render dark
---

# Otis theming model

- Tailwind v4 Vite SPA. No `tailwind.config.*`. Dark mode is **class-based** via
  `@custom-variant dark (&:is(.dark *))` in `artifacts/otis/src/index.css`.
- `:root` holds the light palette; `.dark { }` holds the dark palette. Dark only
  activates when a `.dark` class is on an ancestor element.

## Gotcha: authenticated app rendered dark while sign-in page was light

**Symptom:** server-side/unauthenticated screenshots showed light mode, but the
logged-in dashboard was fully dark for the user.

**Cause:** the authenticated layout wrapper (`components/layout/Shell.tsx`) had a
hardcoded `dark` class on its root `<div>`. The sign-in/landing page is not
wrapped in `Shell`, so it stayed light; everything behind auth inherited `.dark`.

**Why it was hard to spot:** the screenshot tool is never authenticated, so it
only ever captures the (light) sign-in page. Diagnosing theme issues that only
appear when logged in requires inspecting the layout/shell code, not screenshots.

**How to apply:** if light/dark looks inconsistent between public and
authenticated views, grep the layout/shell wrappers for a literal `dark` class
before chasing CSS cascade / `prefers-color-scheme` theories. Don't add
`!important` base overrides or `@media (prefers-color-scheme)` blocks as a
workaround — find the stray `dark` class.
