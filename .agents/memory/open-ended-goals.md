---
name: Open-ended savings goals
description: Nullable goal target semantics and the null-guard hotspots.
---

- Accumulation goals may have `target_amount` AND `target_date` both NULL (never one of the two): user supplies `monthlyContribution` directly; the contribution bill gets `end_date NULL` and runs until stopped via the existing end-date/uncommit path.
- Progress for open-ended goals = amount saved only — no %, no on-track, no target-reached prompt.
- Null-guard hotspots when touching goals: `validateGoalCore` (openEnded branch), `computeBuckets` (target/targetDate locals), forecast spend-pair loop (skips null-target goals — spend goals always have targets), `serializeGoal`, and PATCH merge which must use `!== undefined` (explicit null converts a goal to open-ended; `??` would silently keep the old target).
- **Why:** many code paths assumed notNull targets; `String(null)` writes and NaN renders were the failure mode.
