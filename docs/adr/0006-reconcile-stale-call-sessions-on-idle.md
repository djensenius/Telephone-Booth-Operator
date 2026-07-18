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
- Set `endedAt = idleTime`, `outcome = "aborted"`, and
  `durationMs = endedAt - startedAt`.

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
- No new infrastructure, background job, or schema change — the fix rides on
  an existing authoritative signal.
- Completion-rate stays honest because reconciled sessions are `aborted`, not
  `recording_completed`.

**Trade-offs / caveats:**

- **Booth scoping.** `BoothStatusSnapshot` has no `boothId`, so reconciliation
  is scoped only by time and closes *all* open sessions. This is safe for the
  current single-booth installation. A multi-booth deployment must add the
  reporting booth id to the snapshot and scope reconciliation by it so one
  booth's idle report can never end another booth's live call.
- **Coverage gaps.** Idle reconciliation does not cover a booth that crashes
  mid-call and never reports idle again. Complementary backstops (closing
  sessions from a prior `bootId` when a new boot id appears, and a time-based
  reaper for booths that go fully offline) are possible future additions and
  are intentionally out of scope here.

## References

- `packages/api/src/routes/status.ts` — `reconcileStaleSessionsOnIdle`.
- `packages/api/src/routes/events.ts` — session derivation from booth events.
- `packages/api/src/routes/stats.ts` — `inProgress` and completion-rate.
