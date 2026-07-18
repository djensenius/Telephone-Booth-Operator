# ADR 0006 — Reconcile stale call sessions on booth idle

**Status:** accepted.

## Context

`CallSession` rows are opened by a `call_started` booth event and closed by a
`call_ended` event (`packages/api/src/routes/events.ts`). Stats derive
"calls in progress" from the number of sessions whose `endedAt` is still
`null` (`packages/api/src/routes/stats.ts`).

The booth is a **single-line phone**: at most one call can be active at a
time. Yet the dashboard/screensaver could report **more than one** call in
progress. The cause is a delivery/persistence gap, not missing hook logic —
the Rust client already ends the call on-hook and guarantees "exactly one
`CallEnded` per `CallStarted`". If a `call_ended` event is produced but never
delivered (booth killed between events, power loss mid-recording, a network
drop during `POST /v1/events`), the session's `endedAt` stays `null` forever
and permanently inflates the in-progress count.

Preventing the delivery gap itself (durable event delivery on the booth) is
tracked separately in the booth repository.

## Decision

The API is the system of record for `CallSession`/stats and already receives
an authoritative on-hook signal via `PUT /v1/status` with `state: "idle"`.
Because the booth is idle only when nothing is active, any session still open
at that instant is provably stale.

On the transition into `idle`, the `PUT /v1/status` handler reconciles open
sessions
(`packages/api/src/routes/status.ts` → `reconcileStaleSessionsOnIdle`):

- Find `callSession` rows with `endedAt: null` and `startedAt <= idleTime`,
  where `idleTime` is the snapshot's `updatedAt`.
- Close the whole stale backlog in one atomic `callSession.updateMany` scoped to
  that same `{ endedAt: null, startedAt: { lte: idleTime } }` predicate, setting
  `endedAt = idleTime`, `outcome = "aborted"`, and `durationMs = null`.

A single `updateMany` (rather than a read followed by per-row writes) keeps the
operation atomic and bounded — the stale backlog after a long outage is
unbounded, so one statement avoids a slow per-row round trip that could fail
partway through. The `endedAt: null` predicate keeps the write conditional, so
if an authoritative `call_ended` is persisted by `POST /v1/events` concurrently,
the real event wins the race and is not overwritten by an `aborted`
reconciliation.

`durationMs` is left `null` rather than `idleTime - startedAt`: the call
actually ended at an unknown earlier time (its `call_ended` was never
delivered), so a computed duration would be fiction. It would also overflow the
`Int` column once a session has been open longer than ~24.9 days — exactly the
long-lived rows this reconciliation targets — causing Postgres to reject the
update and leave the session open.

The `startedAt <= idleTime` guard avoids closing a session whose
`call_started` arrives with a timestamp slightly after the idle snapshot
(clock ordering). Reconciliation is idempotent — once closed, nothing remains
open — so repeated idle updates are safe.

We use the `aborted` outcome (already in `CallOutcomeSchema`) rather than
`recording_completed`. Completion-rate metrics count only
`recording_completed`, so reconciled sessions do not inflate the completion
rate; they surface honestly under the `aborted` bucket.

## Consequences

**Good:**

- `inProgress` returns to the true count (0/1) as soon as the booth reports
  on-hook.
- No new infrastructure or background job — the fix rides on an existing
  authoritative signal. The only schema change is a supporting index
  (`CallSession(endedAt, startedAt)`) so the on-idle `updateMany` does not scan
  the full session table.
- Completion-rate stays honest because reconciled sessions are `aborted`, not
  `recording_completed`.

**Trade-offs / caveats:**

- **Booth scoping.** `BoothStatusSnapshot` has no `boothId`, so reconciliation
  is scoped only by time and closes *all* open sessions. This is safe for the
  current single-booth installation. A multi-booth deployment must add the
  reporting booth id to the snapshot and scope reconciliation by it so one
  booth's idle report can never end another booth's live call.
- **Idle event time is optional.** `updatedAt` is optional on
  `StatusUpdateSchema`; when the booth omits it we fall back to the server
  receipt time. The `startedAt <= idleTime` guard is therefore only as strong
  as the supplied timestamp: a delayed or retried idle report that lands after
  a genuinely new call started could abort that call. In practice the booth is
  a single line reporting on-hook transitions, so an accurate idle means no
  call is active; requiring an authoritative client idle timestamp (and
  refusing reconciliation without one) is the robust fix and is deferred to the
  wire-contract/client work.
- **Race with a delayed `call_started`.** Reconciliation only closes sessions
  that exist when it runs. A `call_started` event committed by `POST /v1/events`
  immediately after the `updateMany` can insert a fresh `endedAt: null` row
  whose `startedAt <= idleTime`, re-inflating the open count until the next idle
  report (which, for transition-only reporting, may not arrive). Fully closing
  this needs a persisted idle watermark enforced during session derivation, or
  serialized start-vs-reconcile ingestion; both are larger changes tracked with
  the durable-event-delivery work below.
- **Coverage gaps.** Idle reconciliation does not cover a booth that crashes
  mid-call and never reports idle again. Complementary backstops (closing
  sessions from a prior `bootId` when a new boot id appears, and a time-based
  reaper for booths that go fully offline) are possible future additions and
  are intentionally out of scope here.

## References

- `packages/api/src/routes/status.ts` — `reconcileStaleSessionsOnIdle`.
- `packages/api/src/routes/events.ts` — session derivation from booth events.
- `packages/api/src/routes/stats.ts` — `inProgress` and completion-rate.
