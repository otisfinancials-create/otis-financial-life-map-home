---
name: Drizzle db.execute result shape
description: How raw SQL results come back from Drizzle on node-postgres
---
With node-postgres, `db.execute(sql\`...\`)` returns a QueryResult object — read `result.rows[0]`, do NOT destructure the result as an array (`const [row] = await db.execute(...)` throws "not iterable").
**How to apply:** any raw SQL in api-server services/routes.
