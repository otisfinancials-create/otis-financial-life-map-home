---
name: Scripts package deps
description: Workspace deps that @workspace/scripts needs to declare explicitly
---

When `scripts/src/seed.ts` (or any script) imports from `drizzle-orm`, the import
fails with "Cannot find module" unless `drizzle-orm` is listed in `scripts/package.json`
dependencies — even though `@workspace/db` already uses it.

**Why:** pnpm workspaces don't hoist transitive deps automatically. Each package must
declare its own runtime imports.

**How to apply:** Any time a script directly uses drizzle-orm operators (eq, and, etc.),
add `"drizzle-orm": "catalog:"` to `scripts/package.json` dependencies and run
`pnpm install`.
