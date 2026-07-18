---
name: E2E testing with Clerk auth
description: How to make runTest reliably authenticate, and pitfalls (Turnstile block, HMR-window false failures)
---

# E2E testing against Clerk-authed pages

- Always pass `testClerkAuth: true` AND write the test plan using the programmatic
  sign-in step (`[Clerk Auth] Sign in as {firstName, lastName, email}`) per
  `.local/skills/testing/clerk-auth.md`. If the plan implies using the Clerk
  sign-up UI, the testing agent may hit Cloudflare Turnstile ("Verify you are
  human") and fail with status "unable" — this is a test-plan problem, not an
  app or billing problem. Retrying with the explicit programmatic step fixed it.
- **Why:** the Turnstile widget cannot be automated; programmatic sign-in bypasses
  the UI entirely.
- The test Clerk user has NO app data. Test plans must create their own fixtures
  (e.g. add a bill, regenerate the forecast) before asserting on list/ledger
  content, or they will report "empty page" bugs that aren't real.
- If a test runs while multi-file edits are mid-flight, Vite HMR can apply one
  file before its import source is updated, producing transient ReferenceErrors
  and false test failures. Finish all related edits (and confirm typecheck)
  before launching the test.
