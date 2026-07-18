---
name: Mobile AI tab dead endpoints
description: The Expo app's AI chat tab calls /api/anthropic/* endpoints that were never implemented server-side.
---

The mobile app's AI tab (`app/(tabs)/ai.tsx`) was written against `/api/anthropic/conversations*` endpoints and generated hooks (`useListAnthropicConversations`, etc.) that never existed in the OpenAPI spec or on the server. It failed workspace typecheck until Jul 2026, when the missing imports were replaced by local types + local react-query hooks calling the same (nonexistent) URLs — behavior unchanged: the tab compiles but its network calls 404/401.

**Why:** a merged mobile task shipped UI against an imagined API contract; keeping typecheck green was in-scope, rebuilding the feature was not.

**How to apply:** to actually fix mobile AI chat, retarget it at the real endpoints — `POST /api/otis/chat` (SSE stream) and `GET /api/otis/history` — and route requests through the shared API client auth plumbing (`setAuthTokenGetter` in `@workspace/api-client-react`), not raw fetch without credentials.
