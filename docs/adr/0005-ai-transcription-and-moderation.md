# ADR 0005 — AI transcription and moderation pipeline

**Status:** accepted.

## Context

Operators have to listen to every booth recording before approving or
rejecting it. We want to give them a head start by automatically
transcribing each completed message and running the transcript through a
moderation provider. Two transcription back-ends are in scope:

- **OpenAI** (`/v1/audio/transcriptions`, `/v1/moderations`) — shipping
  now.
- A standalone **Mac app** at `../Telephone-Booth-Transcription` —
  currently a Hummingbird skeleton; we stub the HTTP contract so the app
  can implement it independently.

The pipeline must:

- Persist a full history of transcription and moderation attempts so
  operators can re-run either step and compare.
- Run automatically as soon as the booth finishes uploading a message
  (no operator action required).
- Recover from crashes/restarts without losing in-flight work.
- Stay cheap and easy to operate — no Redis, no extra worker
  processes, no third-party SaaS unless explicitly enabled.

## Decision

### Provider abstraction

Two TypeScript interfaces in `packages/api/src/lib/ai/types.ts`:

- `TranscriptionProvider` — `transcribe({ audioUrl, sha256, durationMs })`
  returns `{ text, language }`.
- `ModerationProvider` — `moderate({ text })` returns
  `{ flagged, recommendation, maxScore, categories, reasonSummary? }`.

Each provider is selected independently by env var:

- `TRANSCRIPTION_PROVIDER = openai | mac_app | disabled` (default
  `disabled`).
- `MODERATION_PROVIDER = openai | mac_app | disabled` (default
  `disabled`).

`disabled` (or missing credentials) returns `null` from the factory and
the pipeline records `status = failed` with `error = "disabled"`. This
keeps non-production environments free.

### Persistence

Two new Prisma tables, `Transcription` and `Moderation`, both keyed on
`messageId` with `(messageId, createdAt)` indexes. We **always insert a
new row** on re-run; the UI shows the latest non-failed row by default
and exposes prior attempts via a history panel. Auto-decisions stamp
`Message.decidedById = null` and write a `notes` audit string.

### In-process worker

We **do not** run BullMQ / Redis. The booth produces a few messages per
hour at most. Instead:

- `POST /v1/messages/:id/complete` calls `kickPipelineForMessage(id)`
  inside `setImmediate` so the booth's request returns immediately.
- A 60-second sweeper (`AI_SWEEPER_INTERVAL_SECONDS`) re-kicks any
  `received` message whose latest transcription is missing or failed —
  this is our crash-recovery story.
- The pipeline catches its own errors and never throws into the request
  path. Every step broadcasts a `kind:"message"` WebSocket envelope so
  the operator UI updates without polling.

### Auto-decision policy

`AUTO_DECISION_MODE` (default `always_pending`) controls what the
pipeline does with `Message.status` after both steps succeed:

- `always_pending` — the pipeline advances `received` messages to
  `pending` so they show up in the operator queue, but never
  auto-approves or auto-rejects.
- `auto_reject` — if `recommendation = reject` (or `maxScore >=
  AUTO_REJECT_THRESHOLD`, default `0.85`), the message is auto-rejected.
  Otherwise it lands in `pending`.
- `auto_both` — also auto-approves when `flagged = false` and
  `maxScore <= AUTO_APPROVE_THRESHOLD` (default `0.15`). Borderline
  scores still go to `pending`.

Auto-decisions write a human-readable `notes` field and leave
`decidedById` null, so the audit trail clearly shows the decision was
not made by a human. Operators can still flip the decision after the
fact.

## Consequences

**Good:**

- One process, one Postgres, one set of env vars — no new infra.
- Operators get a transcript and a recommendation the moment a message
  arrives.
- Providers are pluggable; swapping OpenAI for the Mac app (or a future
  on-prem model) is a config change.
- History is preserved, so re-runs never destroy evidence.

**Trade-offs:**

- An in-process worker can't survive a `kill -9` between booth upload
  and the first pipeline run. The 60-second sweeper closes that gap,
  but tasks could be retried more than once if the API restarts mid-run.
  Provider calls are idempotent at the API level (we always insert a
  new row), so the worst case is duplicate work — never data loss.
- Throughput is bounded by Node event-loop time and the OpenAI quota.
  If volume grows beyond a few messages per minute, a follow-up ADR
  should introduce BullMQ + Redis or a dedicated worker process.
- Transcripts may contain PII. We log only an 80-character preview at
  info level. Operators must treat the UI accordingly.

## Alternatives considered

- **BullMQ + Redis.** Overkill at current volume. Adds a service to
  operate, secure, and back up.
- **Synchronous in-request transcription.** Would block the booth for
  many seconds and tie booth uptime to OpenAI uptime.
- **Always-on auto-approve.** Rejected for safety; we want a human in
  the loop by default.

## References

- `packages/api/src/lib/ai/` — provider implementations, pipeline,
  sweeper.
- `packages/api/openapi.yaml` — new endpoints and schemas.
- [Transcription providers guide](../transcription-providers.md) — env
  vars and provider contracts.
