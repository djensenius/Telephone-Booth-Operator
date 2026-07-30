# ADR 0011 — Audit trail for write actions

**Status:** accepted.

## Context

The operator console lets a small group of people make decisions that are
visible to the public: approving or rejecting a caller's message, editing the
question that the booth asks, pushing a transcription or translation, revoking
an API token. Until now the database recorded the _result_ of those decisions
but not their _provenance_. `Message.status` said "approved"; nothing said who
approved it, from where, or when.

A handful of tables carried partial hints — `Transcription.requestedById`,
`OperatorSession.ip`, `ApiToken.lastUsedAt` — but each was ad hoc, none covered
rejected attempts, and all of them were mutable state rather than an append-only
record. Reconstructing "who did what" meant reading pino logs, which are not
retained, not queryable, and not exposed to operators.

Issue #123 asked for the missing piece directly: every write action should have
a user, an IP, and a timestamp.

## Decision

Add an append-only `AuditLog` table and write one row per mutating `/v1`
request from a single Hono middleware (`packages/api/src/lib/audit.ts`).

- **Middleware, not per-handler.** `auditWrites()` runs on every request and
  writes a row after the handler for `POST`/`PUT`/`PATCH`/`DELETE`. Coverage is
  therefore the default: a new write route is audited the day it is added, even
  if its author forgets. Handlers _enrich_ the row via `recordAudit(c, …)` with
  a stable action name, target, and metadata, but they cannot silently opt out.
- **Mounted before the auth guards.** Anonymous and denied writes (`401`,
  `403`) produce rows too. A rejected attempt to approve a message is precisely
  what an audit trail should show.
- **Recorded after the handler.** `statusCode` is the real response status, so
  outcome is part of the record rather than intent.
- **Denormalized actor label.** `actorLabel` snapshots the operator email or
  `token:<name>` at the time of the action. Foreign keys are
  `ON DELETE SET NULL`, so deleting a user or revoking a token does not erase or
  falsify history.
- **Never fails the request.** A failed insert is logged as
  `audit.write_failed` and the original response is returned unchanged.
  Observability must not become an availability risk.
- **Successful telemetry excluded by default.** `PUT /v1/status`,
  `PUT /v1/system`, and `POST /v1/events` are writes, but they are booth
  heartbeats rather than human decisions. They are matched on route pattern and
  skipped unless `AUDIT_LOG_TELEMETRY=true`. The exclusion is about volume, so
  it applies only to heartbeats that succeeded: one the API rejected is
  recorded like any other denied write.
- **Retention.** `AUDIT_LOG_RETENTION_DAYS` (default 365, `0` = forever) is
  enforced by a background pruner, mirroring the existing snapshot pruner.
- **Read access is admin-only,** through `GET /v1/audit-logs` with prefix
  filtering on action and keyset pagination.

## Consequences

- Any client can answer "who approved this?" without shell access to the
  database or the log stream. The console, CLI, and mobile app all read the same
  endpoint.
- The table grows roughly with operator activity rather than booth uptime, which
  is what makes a 365-day default affordable.
- Audit rows join the admin data export, bumping `EXPORT_VERSION` to `3`.
  Version 2 archives still import; they simply carry no history.
- Metadata is deliberately small and sanitized. Transcript text, plaintext
  tokens, SAS URLs, APNs tokens, and OIDC nonces are never written, so the audit
  table does not become a second, less-guarded copy of sensitive data.
- Two writes now happen per mutating request. The insert is small and indexed,
  and telemetry — by far the highest-volume write path — is excluded, so the
  added cost falls on low-frequency human actions.

## Alternatives considered

- **Per-handler logging only.** Rejected: coverage decays as routes are added,
  and denied writes are the easiest case to forget.
- **Prisma middleware on the model layer.** Rejected: it sees table mutations,
  not intent, so it cannot distinguish `message.approve` from `message.reject`
  and has no access to the request's IP or actor.
- **Structured pino logs shipped to an external store.** Rejected: it adds an
  external dependency for a single-installation art project and puts the trail
  out of reach of the operator UI.
