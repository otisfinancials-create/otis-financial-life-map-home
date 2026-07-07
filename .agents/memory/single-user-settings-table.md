---
name: Single-user user_settings table
description: user_settings is keyed by integer userId (always 1), not Clerk string IDs — retirement and Otis features share one settings row across all users.
---

The `user_settings` table (`lib/db/src/schema/user_settings.ts`) uses `userId: integer, default 1`, while every other table uses Clerk string user IDs. Retirement routes and the Otis financial-context builder all query `userId = 1`, so retirement settings are effectively global/shared across all signed-in users.

**Why:** Legacy from the app's pre-auth single-user phase; migrating requires a schema change (integer → varchar), data migration, and touching retirement routes + frontend together.

**How to apply:** Any new feature reading retirement/user settings inherits this limitation — don't try to pass `req.userId` (a string) into this table's queries; it won't typecheck and the data isn't per-user anyway. If true multi-tenant settings are ever required, migrate the whole table in one dedicated task.
