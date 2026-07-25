---
name: Drizzle pg error codes
description: How to detect unique-violation (23505) and other pg error codes when Drizzle wraps errors
---
Drizzle (>=0.45) wraps database errors in `DrizzleQueryError`; the pg error `code` (e.g. `23505` unique violation) is on `err.cause.code`, NOT `err.code`.

**Why:** a catch checking only `err.code === "23505"` silently rethrows and crashes the flow — this broke the carryover name-collision fallback until the cause chain was checked.

**How to apply:** when catching insert conflicts, read `err.code ?? err.cause?.code` before matching pg error codes.
