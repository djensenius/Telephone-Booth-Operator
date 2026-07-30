# Audit log

Every write action against the operator API is recorded with **who** did it,
**where** it came from, and **when**. That covers approvals, rejections,
transcription and translation work, question and instruction edits, API token
lifecycle, device registration, and admin data imports.

## What gets recorded

One `AuditLog` row is written for every `POST`, `PUT`, `PATCH`, or `DELETE`
request to `/v1`, including requests that were **rejected** — a denied write is
exactly the sort of thing an audit trail exists to capture.

Rejected writes from unauthenticated callers are capped at
`AUDIT_LOG_ANON_LIMIT_PER_MINUTE` rows per address per minute, so a loop
against a real endpoint cannot fill the table. Anything over the cap is
counted, and the count appears as `suppressedSince` on the next recorded row
for that address, so a flood is still visible.

Metadata is bounded as well as sanitized: strings are truncated, nesting is
capped at three levels, objects and arrays are capped in width, and anything
still over ~8 KB is replaced with a `metadata_too_large` marker.

Requests to paths with no handler are the one exception: they are 404s against
a name the caller made up, so recording them would let anyone turn arbitrary
traffic into unbounded rows with attacker-chosen paths. Rejected writes to real
endpoints are still recorded.

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
proxies in `TRUSTED_PROXIES` — bare addresses, CIDR, IPv4 or IPv6, plus the
shorthand `azure-container-apps`, which expands to the private ranges a
Container Apps ingress connects from. A client that can reach the API directly
cannot forge its own address by sending the header.

When the peer _is_ a trusted proxy, `X-Forwarded-For` is read **right to
left**, and the first entry that is not itself a configured proxy wins. This
matters because nginx's `$proxy_add_x_forwarded_for` appends to whatever the
caller sent, so the leftmost entry is attacker-controlled. If every entry is a
known proxy, the socket peer is used.

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

`action` is always a prefix match: `message.` returns the whole family,
`message.approve` just approvals, and `auth.login` logins including the
`auth.login.denied` and `auth.login.failed` variants but not `auth.logout`.
Both endpoints are newest-first with `(createdAt, id)` keyset pagination via
`nextCursor`, which stays correct when several entries share a timestamp.
Cursors are forward-only, so a client that wants to step back keeps the
cursors it has already used — the console does exactly that.

In the console, the trail is at **Observability → Audit log** (`/audit`), with
filters for action family and actor type.

Other clients read the same endpoint:

- **Operator CLI** — `tbo audit` / the Audit screen in the TUI
- **Mobile** — the "Activity" view, plus per-message "decided by" attribution

## Configuration

| Variable                           | Default | Meaning                                                                  |
| ---------------------------------- | ------- | ------------------------------------------------------------------------ |
| `AUDIT_LOG_ENABLED`                | `true`  | Master switch                                                            |
| `AUDIT_LOG_TELEMETRY`              | `false` | Include booth heartbeats                                                 |
| `AUDIT_LOG_RETENTION_DAYS`         | `365`   | Age cutoff; `0` keeps entries forever                                    |
| `AUDIT_LOG_PRUNE_INTERVAL_SECONDS` | `21600` | Pruner cadence, minimum `300`                                            |
| `AUDIT_LOG_ANON_LIMIT_PER_MINUTE`  | `20`    | Cap on anonymous rejected writes per address per minute; `0` disables it |

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
