---
name: TS env var narrowing in closures
description: TypeScript won't narrow process.env.X through async function closures
---

Pattern that breaks:
  const userId = process.env.SEED_USER_ID;
  if (!userId) process.exit(1);
  async function seed() { /* userId still types as string|undefined here */ }

**Why:** TypeScript's control-flow narrowing doesn't cross function definition
boundaries (closures), only sequential execution paths.

**Fix:** After the null check, reassign with an explicit type:
  const userId: string = rawUserId; // TypeScript now knows this is string
Or pass it as a typed parameter: `async function seed(userId: string)`.
