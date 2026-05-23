# Phone-client API tokens

Phone clients authenticate to the Hono API with opaque Bearer tokens. Operator
browsers still use the `__Host-booth_session` cookie; API tokens are only for
the booth/phone client calling routes such as `/v1/uploads/*`,
`/v1/messages/incoming`, and `PUT /v1/status`.

## Token model

Tokens are generated as `tb_` plus 32 random URL-safe characters. The API
stores only:

- `lookupId` — the first 8 characters, indexed for a fast database lookup.
- `tokenHash` — an Argon2id hash of the full plaintext token.
- `last4` — display hint for operators.
- lifecycle fields: `createdAt`, `expiresAt`, `lastUsedAt`, and `revokedAt`.

The plaintext token is returned exactly once by `POST /v1/api-tokens` as
`plaintext`; it is never stored and cannot be recovered later.

## Lifecycle

1. An authenticated operator creates a token with a name and optional
   `expiresInDays` value.
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
phone-client tokens during regular operations windows.
