# ADR 0012 — Refresh-token rotation across API replicas

**Status:** accepted.

## Context

Operator sessions refresh their OIDC access token in-band: when the stored
access token is within a minute of expiry, the request that noticed spends the
refresh token, writes the rotated pair back to `OperatorSession`, and carries
on. `pendingRefreshes` in `packages/api/src/lib/session.ts` coalesces
concurrent refreshes so a burst of parallel requests produces one grant.

That map is process-local. The container app runs up to three replicas
(`docs/azure-deployment.md`), and `docs/authentik-setup.md` tells operators to
leave refresh-token rotation on, so two replicas can read the same stored
refresh token `RT1` for one session:

1. Replica A spends `RT1` and gets `RT2` back.
2. Replica B spends `RT1` and gets `invalid_grant`, because A already
   consumed it.
3. B rereads the session row. If A has committed, B sees a fresh access token
   and defers to it. This case was already handled.
4. If B rereads _before_ A commits, B cannot tell a lost rotation from a
   genuinely dead token. It classifies the session as revoked and deletes the
   row. A's own update then fails against a row that no longer exists, and the
   operator is signed out.

The window is the gap between A receiving its token response and committing it
— a few milliseconds — and both replicas must be serving the same session
inside it. Rare, but it scales with replica count and operator activity, and
the symptom is exactly the spurious logout that ADR-adjacent work in #126 set
out to remove.

There is no comparison that closes this. Making the rejection conditional on
the stored refresh token still matching the rejected one does not help: the
access token and refresh token are written in the same `update`, so every
moment where the comparison would save the session is a moment where the
existing freshness reread has already saved it. The only unhandled ordering is
B reading before A writes, where the stored token is still `RT1` and every
comparison agrees with B. A conditional delete has the same problem and merely
relocates the failure to A, whose update then throws.

## Decision

On a **rejected** refresh — and only on a rejected one — wait
`REFRESH_RACE_REREAD_DELAY_MS` (250 ms) and reread the session row once more
before destroying it. If that reread shows a healthy session, the request
defers to it exactly as it does on the immediate reread.

- **Rejected only.** Transient failures (provider 5xx, network faults) already
  keep the session and retry after a backoff; they never reach the delay.
- **Once.** A single extra read, not a poll loop. The goal is to cover a
  sibling's commit latency, not to wait out an outage.
- **250 ms.** Comfortably longer than the write that A is about to commit,
  short enough that an operator whose token really is dead barely notices.
- **The latency is free.** Every path that reaches the delay and still finds
  nothing healthy ends in a session destroy and a login redirect, which costs
  a full round trip through the IdP anyway.

This narrows the window rather than closing it. That is deliberate.

## Consequences

- A replica that loses a rotation race almost always defers to the winner
  instead of deleting a session that is about to become healthy. The remaining
  failure needs the winner to take longer than 250 ms to commit its update,
  after having already completed a network round trip to the IdP.
- A genuinely revoked or expired refresh token adds 250 ms to the sign-out it
  was always going to produce. No other request path is affected.
- No new infrastructure, no locks, no transaction held open across an outbound
  HTTP call.
- The race is not eliminated. If it is ever observed in practice, the
  serialize-per-session option below is the next step, and this ADR should be
  superseded rather than amended.

## Alternatives considered

- **Serialize per session across replicas** with a Postgres advisory lock
  keyed by session id, taken around read-refresh-write. Correct, and the only
  option that actually closes the window. Rejected for now: it holds a
  transaction across an outbound HTTP call to the IdP, so a slow or hanging
  token endpoint ties up a connection per waiting session — trading a rare
  spurious logout for a new and worse failure mode under exactly the
  conditions (a struggling IdP) where the system is already fragile.
- **A grace period on the previous refresh token,** which some providers
  offer. Authentik does not expose one.
- **Disable refresh-token rotation.** Rejected: it removes a real
  protection against refresh-token theft to paper over a millisecond-wide
  race.
- **Accept it and change nothing.** Defensible — one replica is the steady
  state (`--min-replicas 1`) — but the mitigation is a dozen lines on a path
  that is already a dead end, so the cost of not accepting it is lower than
  the cost of the logout it prevents.
