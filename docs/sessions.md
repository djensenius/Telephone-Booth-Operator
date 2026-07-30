# Operator sessions

Operator UI users authenticate with OIDC Authorization Code + PKCE. After a
successful callback, the API stores an `OperatorSession` row and sends an opaque
`__Host-booth_session` cookie containing only the signed session ID.

## Cookie

- `HttpOnly` so browser JavaScript cannot read it.
- `SameSite=Lax` so the OIDC callback can set it while limiting cross-site use.
- `Secure` so browsers accept the `__Host-` prefix; localhost development still
  works in modern browsers.
- `Path=/` and no `Domain`, matching the `__Host-` cookie prefix rules.
- Expires at the local operator-session lifetime (`SESSION_TTL_SECONDS`, default
  30 days), not at the provider's short access-token lifetime. The expiry slides
  forward as the session is used — see [Lifetime](#lifetime).
- HMAC-signed with `SESSION_SECRET`; rotating this secret logs everyone out.

In non-production localhost development, the API also sets a signed
`booth_session` fallback cookie because some browsers reject `__Host-` cookies
on plain HTTP. Production only accepts the `__Host-booth_session` cookie.

## Lifetime

`SESSION_TTL_SECONDS` (default 30 days) is an **idle** window, not a fixed
deadline. Every authenticated request slides `expiresAt` forward and re-sends
the cookie with the new expiry, so an operator who uses the console regularly is
never asked to log in again. To keep the cost down, the renewal only happens
once the session has burned through a tenth of its idle window, capped at one
renewal per hour.

`SESSION_ABSOLUTE_TTL_SECONDS` (default 90 days) is a hard ceiling measured from
login that activity cannot extend. Set it to `0` to disable it, which leaves the
provider's refresh-token validity as the only bound.

Two other things end a session earlier regardless of these values: the provider
rejecting the refresh token (see below), and the periodic IdP re-check
(`SESSION_REVALIDATE_SECONDS`) finding the account deleted or removed from the
operator group.

## Database model

`OperatorSession` stores the user relation, ID/access tokens, encrypted refresh
token, access-token expiry, local session expiry, timestamps, IP, and user
agent. The cookie is useless without the row, so logout deletes the row and
clears the cookie.

`OperatorUser` is upserted by `oidcSub` and stores the latest email, name,
standard `groups` claim, optional picture URL, and login timestamps.

## Encryption and rotation

Refresh tokens are encrypted at rest with AES-256-GCM using
`SESSION_ENCRYPTION_KEY`, which must be 32 bytes base64 encoded (generate with
`openssl rand -base64 32`). In development, a missing key is generated in memory
with a warning; in production, startup refuses to run without it.

When an access token expires, the operator HTTP middleware uses the encrypted
refresh token to rotate tokens and updates the session. Parallel requests for
the same session share one refresh so providers that rotate refresh tokens, such
as Authentik, do not invalidate the session accidentally.

A failed refresh is classified before anything is destroyed. A 4xx OAuth error
from the token endpoint (typically `invalid_grant`) means the refresh token is
gone for good — expired, rotated away, or revoked — so the local session is
destroyed and the operator logs in again. A transient failure (provider 5xx,
network fault) leaves the session and its tokens intact and retries on the next
request; while the access token is stale the periodic IdP re-check is skipped,
because calling userinfo with an expired token would look like a revoked
account.

The practical upper bound on "remember me" is therefore the provider's
refresh-token validity: if it is shorter than `SESSION_TTL_SECONDS`, operators
are signed out when it lapses. See
[Authentik setup](authentik-setup.md).

The status WebSocket validates the local session when the socket connects, but
it cannot send refreshed cookies during the upgrade. HTTP requests remain the
refresh path.
