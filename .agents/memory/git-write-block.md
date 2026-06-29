---
name: Git write operations are agent-blocked
description: Why agents cannot create git tags/commits/pushes in this Repl and what to do instead
---

# Git writes are blocked for all agents

**Observed:** `git tag -a`, `git commit --allow-empty`, and any operation that
writes to `.git/objects` fail with "Destructive git operations are not allowed
in the main agent. Propose a background Project Task..." — and this fires **even
inside a task-agent environment** assigned specifically to do the git operation.
A bash heredoc (`cat >> file`) issued in the same shell session after a blocked
git call was also rejected with the same error, so prefer the `write` tool over
bash for file edits when git writes have been attempted in the session.

**Implication:** routing a git tag/commit/push to a background Project Task does
NOT unblock it. The guard is environment-wide, not main-agent-only, despite the
wording. The task-agent merge model is for file/code changes that get
reconciled into main; it does not carry raw git metadata like tags.

**The GitHub remote** in this Repl is wired as a `subrepl-*` remote, e.g.
`https://github.com/otisfinancials-create/Otis-Finance-Hub` (repo name differs
from the `replit.md` CI badge URL — the user created a fresh repo).

**How to apply:** when a user wants a milestone tag or release, do NOT spin up a
task to run `git tag` — it will fail. Instead direct them to create a GitHub
Release/tag in the GitHub web UI (repo -> Releases -> Draft a new release ->
enter tag name -> publish), which creates the tag without any local git write.
Pushing commits themselves goes through Replit's Git pane, not agent git
commands.
