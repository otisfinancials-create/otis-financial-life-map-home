---
name: Mailchimp subscribe integration
description: Gotchas for the Coming Soon email-capture -> Mailchimp audience flow
---

The static Coming Soon page posts to a public `POST /api/subscribe` on the shared api-server, which calls the Mailchimp members endpoint server-side (the API key must never reach the browser).

**Gotchas:**
- Mailchimp datacenter is the suffix of the API key after the last `-` (e.g. `...-us21` -> `us21`); the request host is `https://<dc>.api.mailchimp.com`. A wrong/missing dc gives a network/DNS failure, not a 401.
- Distinguish failures by HTTP status from Mailchimp: 401 = bad key, 404 = bad audience id, 400 `title:"Member Exists"` = already subscribed, 400 `title:"Invalid Resource"` = Mailchimp rejected the address as fake/undeliverable.
- **Testing:** Mailchimp rejects `@example.com` and other obviously-fake addresses with 400 "Invalid Resource". Use a real-domain address (e.g. gmail) to smoke-test the happy path — but that adds a real subscriber to the user's live audience, so use throwaway addresses and tell the user to prune them.

**Why:** a fake test email made the happy path look broken ("error") when auth/audience were actually correct; the 400 title is the only reliable signal.
