# ADR 0015 — Explicit between-exhibitions downtime

**Status:** accepted. Supersedes the automatic-start portions of ADR 0013.

## Context

An exhibition can end months before the next starts. A powered-on booth must
not silently start another installation, and a deliberately powered-off booth
must not trigger an exhibition-outage alarm. Recordings already in flight must
still be preserved.

## Decision

Zero active installations is a persistent, intentional lifecycle state.
Only an operator's explicit start (including deliberate archive restoration)
opens an era. No new database field is needed: the absence of an open
`Installation` is authoritative and survives process and replica restarts.

Remove the per-replica active-era cache and all lazy creation. Scoped writes
hold the era row lock, so they either finish before an end or find a currently
open era. With none open, they return a typed `409` problem response with
`error: "installation_inactive"`. This is not a success or duplicate.

The booth reconciles lifecycle asynchronously, stops offering new calls during
the gap, retains durable pending uploads, and resumes them after explicit start.
It does not force-cut a recording already in progress. Event batches remain
unacknowledged for later retry. Hardware telemetry is independent of exhibition
data and may continue.

Current status, stats summary's booth, and monitor summary expose optional
`installationState: active | between_exhibitions`. Synthetic current status
conveys lifecycle but never freshness. Status streaming remains a signal of
booth activity; existing installation envelopes and REST reconciliation supply
lifecycle transitions. Polling remains necessary across API replicas.

Web, Apple, terminal, and BUSY Bar displays distinguish expected downtime from
active-exhibition offline warnings. Missing fields from older servers are
unknown, not proof of inactivity. Actual API/authentication failures and fresh
hardware faults are not hidden.

## Consequences

- Archive summaries and scopes remain unchanged; no data migration is needed.
- An unseeded database requires an explicit first installation.
- Update booth clients before ending an exhibition with the new API. Old
  clients cannot start an era, but do not understand the new admission policy.
- An unfinished uploaded message stays `uploading` until the next start and
  successful completion. Already completed retries remain idempotent.
- The transcription/review service needs no lifecycle gate: it processes
  existing recordings, not new calls, and receives an empty active queue in
  the gap.
