# ADR 0002 — Authentik OIDC

**Status:** accepted.

## Context

The legacy operator used HTTP Basic auth with a single shared password.
That's untenable for a multi-operator install, awkward to rotate, and
puts the operator at risk if the password leaks.

## Decision

Authentik OIDC by default, with group-based authorization:

- Confidential client, Authorization Code + PKCE.
- ID-token signature validated against Authentik's JWKS.
- A configurable `groups` claim gates UI access (default group:
  `telephone-booth-operators`).
- Session cookie HMAC-signed with `SESSION_SECRET`, 12-hour sliding
  expiry, `HttpOnly` + `Secure` + `SameSite=Lax`.

Any OIDC-compliant IdP works via the generic `OIDC_*` env vars; see
`docs/other-providers/`.

## Consequences

**Good:**

- Operator onboarding is a one-click "add to group" — no code or DB
  changes.
- Rotation, revocation, MFA all handled by the IdP.
- Same flow works for any compliant provider, so we don't lock anyone
  to Authentik.

**Trade-offs:**

- Need an IdP available, even for tests — solved by running a
  dependency `oidc-provider` mock in CI.
- One extra service to maintain (or rely on an existing one — Authentik
  is small and self-hostable).
