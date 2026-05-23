# Operator sessions

Operator UI users authenticate with OIDC Authorization Code + PKCE. After a
successful callback, the API stores an `OperatorSession` row and sends an
opaque `__Host-booth_session` cookie containing only the signed session ID.

## Cookie

- `HttpOnly` so browser JavaScript cannot read it.
- `SameSite=Lax` so the OIDC callback can set it while limiting cross-site use.
- `Secure` on non-localhost hosts.
- `Path=/` and no `Domain`, matching the `__Host-` cookie prefix rules.
- HMAC-signed with `SESSION_SECRET`; rotating this secret logs everyone out.

## Database model

`OperatorSession` stores the user relation, ID/access tokens, encrypted refresh
token, expiry, timestamps, IP, and user agent. The cookie is useless without the
row, so logout deletes the row and clears the cookie.

`OperatorUser` is upserted by `oidcSub` and stores the latest email, name,
standard `groups` claim, optional picture URL, and login timestamps.

## Encryption and rotation

Refresh tokens are encrypted at rest with AES-256-GCM using
`SESSION_ENCRYPTION_KEY`, which must be 32 bytes base64 encoded (generate with
`openssl rand -base64 32`). In development, a missing key is generated in memory
with a warning; in production, startup refuses to run without it.

When an access token expires, the operator middleware uses the encrypted refresh
token to rotate tokens and updates the session. If refresh fails, the local
session is destroyed and the user must log in again.
