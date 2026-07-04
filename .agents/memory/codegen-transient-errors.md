---
name: Codegen transient reload errors
description: Orval codegen briefly deletes generated files, causing transient Vite/Metro "failed to load" errors
---

Running `pnpm --filter @workspace/api-spec run codegen` deletes and rewrites `lib/api-client-react/src/generated/*` and `lib/api-zod/src/generated/*`. Dev servers watching those files (Vite HMR, Expo/Metro) emit "Failed to reload" / "Unable to resolve ./generated/api" errors during the window.

**Why:** The errors look like real breakage but are transient; the files exist again once codegen finishes.

**How to apply:** After codegen, ignore reload errors timestamped during the codegen window. Vite recovers on the next HMR update; Metro (Expo) caches the failure — restart the expo workflow to clear it.
