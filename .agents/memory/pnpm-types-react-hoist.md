---
name: Duplicate @types/react via pnpm hidden hoist
description: Why repo-wide typecheck broke with "Two different types with this name exist" and how to fix it
---

Rule: keep a single `@types/react` version across the whole workspace — every package (including the Expo app) should use `"@types/react": "catalog:"`.

**Why:** pnpm hoists one arbitrary `@types/react` into its hidden hoist dir (`node_modules/.pnpm/node_modules/@types/react`). Packages without an explicit `@types/react` peer (lucide-react, react-day-picker, etc.) resolve React types through that hoist. When the Expo app pinned `~19.1.x` while the catalog had `^19.2.0`, the hoist pointed at 19.1 and web packages failed typecheck with `VoidOrUndefinedOnly ... Two different types with this name exist` in unrelated files (ui/calendar.tsx, ui/spinner.tsx, mockup-sandbox).

**How to apply:** if that error appears, check `ls node_modules/.pnpm | grep '@types+react@'` and `readlink node_modules/.pnpm/node_modules/@types/react`. Fix by aligning all package.json pins to `catalog:` and running `pnpm install` (plus `pnpm dedupe @types/react @types/react-dom` if stale duplicates linger). Deleting `.tsbuildinfo` files is not enough on its own.
