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

  classDef ext fill:#fef,stroke:#a4a;
  class Blob,DB,Authentik,Phone ext;
```

## Packages

| Package           | Notes                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `packages/api`    | Hono on the Node runtime. Prisma + Postgres. Routes per resource.    |
| `packages/web`    | React + Vite + TypeScript. TanStack Router + Query. Themed shell.    |
| `packages/shared` | Zod schemas + TS types both packages import. Source of wire-type truth.|

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
   blob, checks the content-addressed SHA-256, marks the message
   `received`, and returns `{id, status, receivedAt}`.
5. Phone status updates sent to `PUT /v1/status` are appended to
   `BoothStatusSnapshot` and broadcast over the cookie-authenticated
   `/v1/ws/status` WebSocket; missing-cookie clients are closed with
   policy violation `1008`.

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
   (`HttpOnly`, `Secure` off localhost, `SameSite=Lax`).
5. `OperatorUser` row is upserted keyed by `oidcSub`.

See [`authentik-setup.md`](authentik-setup.md) for the IdP config,
[`other-providers/generic-oidc.md`](other-providers/generic-oidc.md) for
provider portability, and [`sessions.md`](sessions.md) for cookie/session
storage details.

## Data model

See `packages/api/prisma/schema.prisma` for the canonical schema.

- `Question`, `Message`, `File` — content tables. `File` is content-addressed
  by `sha256` so duplicate uploads dedupe.
- `OperatorUser` — humans authenticated via OIDC, keyed by `oidcSub`. Created
  lazily on first successful login.
- `OperatorSession` — browser session rows referenced by signed opaque cookies;
  refresh tokens are encrypted at rest.
- `ApiToken` — phone-client tokens, stored hashed with Argon2id; plaintext
  shown to the operator once on creation.
- `BoothStatusSnapshot` — append-only log of status updates from the phone
  client, used to power the live status panel and historical charts.
