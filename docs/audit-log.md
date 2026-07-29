# Audit log

Every write action against the operator API is recorded with **who** did it,
**where** it came from, and **when**. That covers approvals, rejections,
transcription and translation work, question and instruction edits, API token
lifecycle, device registration, and admin data imports.

## What gets recorded

One `AuditLog` row is written for every `POST`, `PUT`, `PATCH`, or `DELETE`
request to `/v1`, including requests that were **rejected** — a denied write is
exactly the sort of thing an audit trail exists to capture.

| Field                          | Meaning                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `action`                       | Stable name, e.g. `message.approve`, `question.archive`      |
| `actorType`                    | `operator`, `apiToken`, `anonymous`, or `system`             |
| `actorLabel`                   | Snapshot of the operator email or `token:<name>` at the time |
| `actorUserId` / `actorTokenId` | Foreign keys, nulled if the user or token is later deleted   |
| `targetType` / `targetId`      | What was acted on, e.g. `message` + its id                   |
| `ip`                           | Client address (proxy-aware, see below)                      |
| `userAgent`                    | Truncated request user agent                                 |
| `method` / `path`              | Request method and route                                     |
| `statusCode`                   | Real response status, so outcome is visible                  |
| `metadata`                     | Small action-specific detail (see [Metadata](#metadata))     |
| `createdAt`                    | Timestamp                                                    |

Sign-in is not a mutating request, so it is recorded explicitly as
`auth.login`, `auth.login.denied`, or `auth.login.failed`. Sign-out is
`auth.logout`.

### Action names

| Family        | Actions                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Messages      | `message.create`, `message.complete`, `message.delete`, `message.approve`, `message.reject`, `message.transcribe.request`, `message.moderate.request`, `message.translation.submit`, `message.transcription.push`, `message.translation.push`, `message.moderation.push` |
| Questions     | `question.create`, `question.activate`, `question.deactivate`, `question.archive`                                                                                                                                                                                        |
| Instructions  | `instruction.create`, `instruction.activate`, `instruction.deactivate`, `instruction.delete`                                                                                                                                                                             |
| API tokens    | `apiToken.create`, `apiToken.revoke`                                                                                                                                                                                                                                     |
| Devices       | `device.register`, `device.update`, `device.revoke`                                                                                                                                                                                                                      |
| Uploads       | `upload.sas.issue`                                                                                                                                                                                                                                                       |
| Stats filters | `metricFilter.create`, `metricFilter.update`, `metricFilter.delete`                                                                                                                                                                                                      |
| Admin         | `admin.data.import`                                                                                                                                                                                                                                                      |
| Auth          | `auth.login`, `auth.login.denied`, `auth.login.failed`, `auth.logout`                                                                                                                                                                                                    |

Any write that a handler does not name explicitly still gets a row, using the
fallback action `http.<method> <route pattern>`.

### Metadata

`metadata` holds a small, sanitized object — decision reasons, transcription
provider and model names, text lengths, language codes, counts. It never
contains transcript text, plaintext API tokens, SAS URLs, APNs device tokens,
OIDC nonces, or `code_verifier` values.

### Client IP

The IP is the TCP peer address unless that peer matches one of the reverse
proxies in `TRUSTED_PROXIES` (bare addresses or CIDR, IPv4 or IPv6), in which
case the first `X-Forwarded-For` entry is used instead. A client that can reach
the API directly therefore cannot forge its own address by sending the header.
IPv4-mapped IPv6 addresses (`::ffff:203.0.113.7`) are normalized. The same
helper backs `OperatorSession.ip`, so sessions and audit rows always agree.

## Telemetry

Booth heartbeats (`PUT /v1/status`, `PUT /v1/system`, `POST /v1/events`) are
writes, but they are machine chatter rather than decisions, so they are skipped
by default. Set `AUDIT_LOG_TELEMETRY=true` to record them too — expect the table
to grow quickly.

## Reading the trail

Admins only.

```http
GET /v1/audit-logs?action=message.&actorType=operator&limit=50
GET /v1/audit-logs/targets/message/<id>
```

`action` is a prefix match, so `message.` returns the whole family and
`message.approve` returns just approvals. Both endpoints are newest-first with
`(createdAt, id)` keyset pagination via `nextCursor`, which stays correct when
several entries share a timestamp.

In the console, the trail is at **Observability → Audit log** (`/audit`), with
filters for action family and actor type.

Other clients read the same endpoint:

- **Operator CLI** — `tbo audit` / the Audit screen in the TUI
- **Mobile** — the "Activity" view, plus per-message "decided by" attribution

## Configuration

| Variable                           | Default | Meaning                               |
| ---------------------------------- | ------- | ------------------------------------- |
| `AUDIT_LOG_ENABLED`                | `true`  | Master switch                         |
| `AUDIT_LOG_TELEMETRY`              | `false` | Include booth heartbeats              |
| `AUDIT_LOG_RETENTION_DAYS`         | `365`   | Age cutoff; `0` keeps entries forever |
| `AUDIT_LOG_PRUNE_INTERVAL_SECONDS` | `21600` | Pruner cadence, minimum `300`         |

Audit writes never fail a request. If the insert throws, the API logs
`audit.write_failed` through pino and the original response still goes out.

## Retention and export

The pruner deletes entries older than `AUDIT_LOG_RETENTION_DAYS` on the
configured interval. Audit rows are included in the admin data export/import
(`docs/runbook.md`), which is why `EXPORT_VERSION` is now `3`; archives written
by older versions still import, they just carry no audit history. Restore is
insert-only for audit rows: an archive may add history that is missing locally,
but it can never rewrite an entry that already exists.

## Related

- [Architecture](architecture.md)
- [Sessions](sessions.md)
- [API tokens](api-tokens.md)
- [ADR 0011 — Audit trail for write actions](adr/0011-audit-trail-for-write-actions.md)
