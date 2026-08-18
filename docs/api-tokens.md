# API tokens

Phone clients authenticate to the Hono API with opaque Bearer tokens. Operator
browsers still use the `__Host-booth_session` cookie; API tokens are only for
the booth/phone client calling routes such as `/v1/uploads/*`,
`/v1/messages/incoming`, and `PUT /v1/status`.

Router component collectors use the same token mechanism with the narrower
`telemetry` scope and `PUT /v1/system/components/current`.

## Token model

Tokens are generated as `tb_` plus 32 random URL-safe characters. The API
stores only:

- `lookupId` — the first 8 characters, indexed for a fast database lookup.
- `tokenHash` — an Argon2id hash of the full plaintext token.
- `last4` — display hint for operators.
- `scope` — capability scope: `operator` (default), `worker`, `monitor`, or
  `telemetry`.
- `telemetrySourceId` — required only for `telemetry`; binds the credential to
  one persistent booth component.
- lifecycle fields: `createdAt`, `expiresAt`, `lastUsedAt`, and `revokedAt`.

The plaintext token is returned exactly once by `POST /v1/api-tokens` as
`plaintext`; it is never stored and cannot be recovered later.

## Scopes

Every token carries a `scope` that bounds what it may access. Choose the
narrowest scope for the credential's job:

- **`operator`** (default) — the historical scope for booth/phone clients and
  native operator clients (iOS/watchOS/tvOS, the Rust CLI). Grants the
  booth/phone REST routes and the read-only operator status stream on
  `/v1/ws/status` (status, system, and message envelopes — including audio SAS
  URLs and transcript/moderation content).
- **`worker`** — a least-privilege credential for the push-mode Transcription
  worker. It may call only the `/v1/worker/*` result-callback routes and, on
  `/v1/ws/status`, receives **only** `work` scheduling events — never the
  `message` envelopes that carry audio SAS URLs and transcript/moderation
  content. (Content the worker must process is fetched deliberately from its
  input route `GET /v1/worker/messages/:id/work`; it is the broadcast
  WebSocket stream, not the worker input, that excludes content.) An
  operator-scoped token can never read `work` events.
- **`monitor`** — a read-only credential for the external BUSY Bar companion.
  It may read only `GET /v1/status`, `GET /v1/system/current`, and the
  aggregate-only `GET /v1/monitor/summary`; on `/v1/ws/status` it receives only
  `status` and `system` envelopes.
- **`telemetry`** — a write-only credential for one router component. It may
  call only `PUT /v1/system/components/current`. The API derives `boothId` and
  `componentId` from the token's `TelemetrySource` relation rather than the
  request body. It cannot read the operator API or subscribe to the WebSocket.

Requests to `/v1/worker/*` with a non-`worker` token are rejected with
`403 insufficient_scope`. Monitor tokens are likewise rejected from booth
writes and operator message content, and telemetry tokens are rejected from
every non-telemetry route. Tokens created before scopes existed default to
`operator`, preserving their prior behavior.

## Lifecycle

1. An authenticated operator creates a token with a name, a `scope`
   (`operator`, `worker`, `monitor`, or `telemetry`), and an optional
   `expiresInDays` value. Telemetry tokens also require source metadata:
   `boothId`, `componentId`, `displayName`, `kind`, `prometheusJob`, and
   `prometheusInstance`.
2. The API stores the Argon2id hash and returns the plaintext once.
3. The phone client sends `Authorization: Bearer <token>` on protected phone
   routes.
4. Verification uses `lookupId`, Argon2id verification, and a 60-second
   in-memory LRU cache (256 entries). Valid uses queue `lastUsedAt` updates and
   flush them about every 30 seconds.
5. Deleting a token sets `revokedAt`; it does not remove the audit row.

Usage charts are based on `lastUsedAt` only, not a per-request log. This keeps
the data model small and avoids write amplification for a single-booth system.

## Rotation guidance

Create and install the replacement token before revoking the old one:

1. Operator UI → Settings → API tokens → **Create**.
2. Copy the new plaintext token into the phone client's config.
3. Restart the phone client.
4. Confirm it reconnects and uploads/status calls succeed.
5. Revoke the old token.

Prefer expiring tokens for temporary maintenance devices and rotate long-lived
phone-client tokens during regular operations windows. Issuing another
telemetry token for the same `(boothId, componentId)` reconnects it to the
existing source, so rotation preserves current state and history identity.
