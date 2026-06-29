---
name: Clerk dev session 401s in Replit preview iframe
description: Why authenticated API calls 401 in the preview pane even though the code is correct, and the fix.
---

# Clerk dev 401s in the Replit preview iframe

Symptom: signed-in web app shows no data ("all my data is gone"); every protected
`/api/*` request returns 401 in dev. DB rows are intact — this is auth, not data loss.

Diagnosis that pinpoints it: temporarily log `getAuth(req)` in `requireAuth`. When the
`__session` cookie IS present (`hasSessionCookie: true`) but the auth object is
`{ sessionStatus: null, sessionId: null, userId: null, isAuthenticated: false }`
(status null, NOT "expired"), Clerk received the cookie but could not resolve it to a
session. In dev the Replit preview runs inside an iframe on a different site, so the
browser treats the app's cookies as third-party and partitions/blocks them — Clerk
never establishes a usable session.

**Fix:** open the app in its OWN browser tab (preview "Open in new tab", first-party
context), then sign in there. Data loads. No code change needed.

**Why:** Clerk web auth is cookie-based; third-party-cookie restrictions in the iframe
break the session cookie. The auth code (`clerkMiddleware` + `requireAuth` +
cookie-based `customFetch`) was canonical and unchanged the whole time.

**How to apply:** Before touching auth code for dev 401s, confirm cookie presence vs
`sessionStatus`. If cookie present + status null → iframe/first-party issue, tell the
user to use a real tab. Do NOT add Bearer/`setAuthTokenGetter` to web (that's mobile-only).
Note: 401s whose `origin` is the `*.expo.*` domain with no cookie are the Expo app and
are unrelated.
