---
name: Light mode theme
description: The app was converted from dark to light mode. Key color values and what files to update when changing the theme.
---

## Rule
The default theme is light mode. `:root` in `artifacts/otis/src/index.css` holds light values. The `.dark` class holds the original dark values for a future toggle.

**Why:** User requested light mode as of June 2026. The "Bloomberg meets Notion" aesthetic works in both modes; light mode is now the default.

**How to apply:** When updating the theme, change `:root` in `index.css`. Also update `clerkAppearance` in `App.tsx` (hardcoded HSL values for Clerk's sign-in/up UI). Category badge colors in `forecast.tsx` use light-mode Tailwind classes (bg-*-100 text-*-700).

## Key light-mode values (HSL)
- Background: 210 17% 98% (#f8f9fa)
- Card: 0 0% 100% (#ffffff)
- Sidebar: 210 17% 95% (#f1f3f5)
- Foreground/headings: 240 28% 14% (#1a1a2e)
- Muted text: 0 0% 40% (#666)
- Border/input: 214 32% 91% (#e2e8f0)
- Primary blue: 210 100% 50% (#0080ff)
