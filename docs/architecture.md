# Architecture

The operator stack is a pair of stateless services that share a Postgres
database and an Azure Blob container.

```mermaid
flowchart LR
  Phone[Rust phone client] -->|Bearer API token| API
  Browser[Operator browser\n(React)] -->|Session cookie| API
  Browser -->|WS /v1/ws/status| API
  API[Hono API] --> DB[(Postgres\nvia Prisma)]
  API -->|presigned SAS| Phone
  Phone -->|PUT FLAC| Blob[(Azure Blob\nbooth-recordings)]
  Browser -->|GET FLAC via short-lived SAS| Blob
  Browser -->|OIDC login| Authentik[Authentik\nIdP]
  API -->|JWKS / token exchange| Authentik
  API -->|BUSY Cloud HTTP + WS| BusyBar[BUSY Bar\nstatus monitor]

  classDef ext fill:#fef,stroke:#a4a;
  class Blob,DB,Authentik,Phone ext;
  class BusyBar ext;
```

## Packages

| Package           | Notes                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `packages/api`    | Hono on the Node runtime. Prisma + Postgres. Routes per resource.       |
| `packages/web`    | React + Vite + TypeScript. TanStack Router + Query. Themed shell.       |
| `packages/shared` | Zod schemas + TS types both packages import. Source of wire-type truth. |

The API's `openapi.yaml` is the **second** source of truth, used to
generate the typed fetch client in `packages/web/src/api/schema.gen.ts`
via `openapi-typescript`. Shared Zod is what the API and seed scripts
runtime-validate against; OpenAPI is what the browser client is typed
against. Both must stay aligned — `just openapi-gen` regenerates after a
spec change.

## Request flow: phone uploads a recording

1. Phone client `POST /v1/messages` with `{questionId?, durationMs, sha256}`.
2. API creates a `File` + `Message` row (status: `uploading`), mints a
   15-minute SAS URL scoped to `messages/<sha-prefix>/<sha>.flac`, and
   returns `{id, uploadUrl, blobName}`.
3. Phone client `PUT`s the FLAC to `uploadUrl` directly — Azure
   terminates the upload, the API never sees the bytes.
4. Phone client `POST /v1/messages/{id}/complete`. The API stat's the
   blob, checks the content-addressed SHA-256, moves the message straight to
   `pending` (the operator review queue), and returns
   `{id, status, receivedAt}`. Transcription is optional enrichment pushed in
   later by the external Transcription app, so it never gates review — see
   [`operator-push.md`](operator-push.md).
5. Phone status updates sent to `PUT /v1/status` are recorded in
   `BoothStatusSnapshot` — a report identical to the run that was current at
   its own timestamp is collapsed into that run rather than appended — and
   broadcast over the
   `/v1/ws/status` WebSocket. Browser operators authenticate with the
   session cookie; native clients (iOS/watchOS/tvOS, the Rust CLI) present
   an `Authorization: Bearer` token. Clients that present neither a valid
   cookie nor a valid bearer are closed with policy violation `1008`.
6. When the optional BUSY Bar monitor is enabled, the API consumes the same
   in-process status/system envelopes, renders a front-first physical display
   through BUSY Cloud, and receives BUSY input events only for diagnostic-page
   navigation. It does not expose or call booth mutation operations.

## Request flow: operator login

1. Browser hits `/v1/auth/login`. API generates `state`, `nonce`,
   `code_verifier`, stores them in a short-lived signed cookie, and
   redirects to Authentik.
2. Authentik authenticates the user and redirects back to
   `/v1/auth/callback?code=…&state=…`.
3. API exchanges code for tokens, validates ID token signature against
   Authentik's JWKS, verifies `nonce`, asserts the user is in
   `AUTHENTIK_REQUIRED_GROUP`.
4. Sets a `__Host-booth_session` HMAC-signed cookie carrying an opaque session ID
   (`HttpOnly`, `Secure`, `SameSite=Lax`).
5. `OperatorUser` row is upserted keyed by `oidcSub`.

See [`authentik-setup.md`](authentik-setup.md) for the IdP config,
[`other-providers/generic-oidc.md`](other-providers/generic-oidc.md) for
provider portability, and [`sessions.md`](sessions.md) for cookie/session
storage details.

## Data model

See `packages/api/prisma/schema.prisma` for the canonical schema.

Prisma 7 keeps the connection URL out of the schema: `packages/api/prisma.config.ts`
reads `DATABASE_URL` for the CLI (migrations, introspection), and the runtime
client is constructed with the `@prisma/adapter-pg` driver adapter in
`packages/api/src/lib/db.ts`. The client is generated as TypeScript into
`packages/api/src/generated/prisma`, which is gitignored and compiled into
`dist` alongside the rest of the API, so `prisma generate` must run before
`build`.

- `Installation` — one run of the booth, with a start, an end, and frozen
  summary counters. `Message`, `CallSession`, `BoothEvent`,
  `BoothStatusSnapshot`, and `Question` all carry an `installationId`, and a
  partial unique index keeps at most one active at a time. Reads default to
  the active installation, so ending one and starting the next resets every
  stat without deleting anything
  (see [installations](installations.md) and
  [ADR 0013](adr/0013-installations-as-data-scope.md)).
- `Question`, `Message`, `File` — content tables. `File` is content-addressed
  by `sha256` so duplicate uploads dedupe.
- `OperatorUser` — humans authenticated via OIDC, keyed by `oidcSub`. Created
  lazily on first successful login.
- `OperatorSession` — browser session rows referenced by signed opaque cookies;
  refresh tokens are encrypted at rest.
- `ApiToken` — phone-client tokens, stored hashed with Argon2id; plaintext
  shown to the operator once on creation.
- `BoothStatusSnapshot` — log of status updates from the phone client, used to
  power the live status panel and historical charts. Identical consecutive
  reports (the booth's status heartbeat) are collapsed into a single row
  spanning `firstSeenAt`..`updatedAt` with a `repeatCount`
  (see [ADR 0010](adr/0010-collapse-repeated-booth-status-reports.md)).
- `AuditLog` — append-only record of every write action, with the actor, IP,
  timestamp, and outcome (see [Audit log](audit-log.md) and
  [ADR 0013](adr/0011-audit-trail-for-write-actions.md)).

## AI pipeline: transcription, translation, moderation

A recording goes through three steps after upload, all driven by the API
process:

1. **Transcription** — audio → text + detected language.
2. **Translation** — if the detected language isn't English, text →
   English. Stored on the same transcription row
   (`translatedText`, `translatedLanguage`, …). Skipped for English.
3. **Moderation** — runs against the translated text when present,
   otherwise the original transcript. Produces an **advisory** suggestion
   (`recommendation`: `approve` / `review` / `reject` + scores). It never
   decides the message: a human always approves/rejects via
   `POST /v1/messages/:id/decision` (see [ADR 0009](./adr/0009-human-moderation-and-push-worker.md)).

Each step has its own provider abstraction (`packages/api/src/lib/ai/`).
Built-in providers: OpenAI (cloud), `mac_app` (push to a reachable Mac),
and `disabled`. The Transcription app (macOS + iOS) can additionally run as a
**push** worker: it subscribes to `/v1/ws/status` for `work` events and posts
results back to `/v1/worker/*` — see [`operator-push.md`](./operator-push.md).
