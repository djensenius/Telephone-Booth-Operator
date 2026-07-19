# ADR 0009 — Human-only moderation and push-based transcription worker

**Status:** accepted. Supersedes the auto-decision policy in
[ADR 0005](./0005-ai-transcription-and-moderation.md) and replaces the
pull-mode job queue it introduced.

## Context

Two properties of the original pipeline (ADR 0005) no longer match how the
installation is run:

1. **Auto-decision.** `AUTO_DECISION_MODE` let the pipeline auto-approve or
   auto-reject a message from the moderation score. The owner wants **every**
   message decided by a human; the AI output is only a *suggestion*.
2. **Pull-mode work queue.** The standalone Transcription app
   (`../Telephone-Booth-Transcription`, macOS **and** iOS) fetched work by
   polling `/v1/jobs/*` and leasing rows. Polling adds latency and lease
   bookkeeping (`leaseToken`, `leaseExpiresAt`, `attemptCount`) that only
   exists to make the pull model safe.

## Decision

### 1. Moderation is advisory-only (human decides)

- Removed `AUTO_DECISION_MODE`, `AUTO_REJECT_THRESHOLD` and
  `AUTO_APPROVE_THRESHOLD`. The pipeline never sets `approved`/`rejected`
  itself; after transcription + moderation succeed it only advances a
  `received` message to `pending`.
- The moderation row still carries `flagged`, `recommendation`, `maxScore`,
  `categories` and `reasonSummary` — these are the **suggestion** surfaced to
  operators. The former reject/approve thresholds now only map a score to the
  advisory `recommendation` label (`moderationRejectThreshold` /
  `moderationApproveThreshold`).
- A human always decides via `POST /v1/messages/:id/decision`. The web,
  mobile and CLI operator apps each surface the AI suggestion as advisory and
  offer approve/reject controls.

### 2. Push replaces pull

- Deleted the `/v1/jobs/*` router and the lease columns/indexes on
  `Transcription` and `Moderation` (migration
  `20260719000000_drop_job_leases`).
- The Transcription app now **subscribes** to the existing status WebSocket
  (`/v1/ws/status`), authenticating with its static Argon2id API token (the WS
  upgrade authorizer accepts cookie, Authentik bearer, **or** a valid API
  token).
- New `work` WS envelope: `{ kind: "work", messageId, needs: [...] }`. It
  carries **no** audio URL or secrets, because the status channel is shared
  with browser operators.
- After a `work` event the app pulls the inputs it needs over its
  authenticated connection (`GET /v1/worker/messages/:id/work` — returns a
  short-lived read-only audio SAS URL and the latest transcript/translation),
  runs the step locally, and POSTs the result back to
  `POST /v1/worker/messages/:id/{transcription,translation,moderation}`.
- The pipeline emits `work` events when a step needs doing (and on the
  crash-recovery sweep), so a reconnecting app catches up.

### 3. Idempotency without leases

Dropping leases removes multi-worker safety. Callbacks are therefore
**claim-free and last-writer-wins**, and every write is guarded so a
stale/duplicate callback cannot downgrade an already-finalized row (e.g. a
`succeeded` translation is never flipped back to `pending`). If more than one
Transcription app ever subscribes they may both run the same message; the
guards keep the result consistent, at the cost of duplicated local compute.
This is an accepted trade-off for the single-speaker installation.

## Consequences

**Good:**

- Humans own every moderation decision; the audit trail no longer contains
  machine-made decisions.
- Lower latency (event-driven, not poll-interval) and less schema/bookkeeping
  (no lease columns).
- The `work` envelope leaks nothing sensitive to browser clients.

**Trade-offs:**

- No lease-based mutual exclusion. Safe for one worker; duplicated work is
  possible (but harmless) with several.
- The Operator can no longer auto-clear obviously-bad messages; the review
  queue depends on a human being present.
