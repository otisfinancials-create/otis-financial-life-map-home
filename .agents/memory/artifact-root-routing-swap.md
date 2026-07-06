---
name: Artifact root-path routing swap
description: How to change which web artifact is served at the deployment root in this multi-artifact monorepo
---

Only one web artifact can own `/`. To put a different artifact at the root (e.g. serve the Coming Soon page while the main app hides at `/app/`), swap `previewPath`, the service `paths`, and `[services.env].BASE_PATH` in BOTH artifacts' `.replit-artifact/artifact.toml` via `verifyAndReplaceArtifactToml` (temp-file workflow), then restart both web workflows.

**Why:** `paths` applies to both dev and prod (no prod-only path override), so swapping affects the preview too. Routes are matched most-specific-first, so `/api` and `/app/` still win over the root catch-all.

**How to apply:** The Otis app survives moving off `/` because its API calls are root-relative (`fetch("/api/...")`) which always hit the api-server mounted at `/api` regardless of the frontend's base, and wouter takes its base from `import.meta.env.BASE_URL` (set from `BASE_PATH`). So only routing/base needs changing — no code edits. To revert (make the main app public at root), swap the three values back.
