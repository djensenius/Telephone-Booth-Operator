# ADR 0010 — Collapse repeated booth status reports

**Status:** accepted.

## Context

The phone client pushes its current status to `PUT /v1/status` twice: once on
every state transition, and again on a periodic heartbeat
(`spawn_status_heartbeat` in the booth repo) so the operator never shows stale
state after a dropped push. The API appended one `BoothStatusSnapshot` row per
report.

The booth is idle almost all of the time, so the snapshot table — and the
operator's "last 50 snapshots" panel — filled up with identical `idle` rows.
The history covered only a few minutes of wall-clock time and hid every genuine
transition (`recording`, `uploading`, `error`) behind a page of heartbeats. The
same duplication reached the mobile app's status chart, and the API needed a
`snapshot-pruner` job purely to keep the table from growing without bound.

## Decision

`PUT /v1/status` collapses a report into the run that was current at the
report's own timestamp — normally the newest snapshot — instead of inserting a
new row (`packages/api/src/routes/status.ts`):

- Two reports are identical when `state`, `currentQuestionId`,
  `currentMessageId`, `lastError`, and `runtimeMode` all match. `updatedAt` is
  excluded — it is what changes on every heartbeat.
- A collapsed row spans a window: `firstSeenAt` is the earliest report of the
  status, `updatedAt` the most recent, and `repeatCount` the number of reports
  folded in. A report is folded into the run that was current at its own
  `updatedAt` — the newest row starting at or before it, or, when that row is a
  different status, the next run to start — so a delayed report counts towards
  the run it actually belongs to instead of the run that has since started, and
  never lands as a duplicate row between two identical ones. Folding widens
  that run's window; it never rewinds `updatedAt`.
- Anything that differs — a real transition, a new error string, a runtime-mode
  change — still creates a new row, so the history reads as one row per booth
  status.
- Runs are scoped to one installation; a rollover starts a fresh run even when
  the booth's heartbeat is otherwise identical.

`firstSeenAt`, `repeatCount`, and the snapshot's row `id` are added to the
`BoothStatus` wire shape as optional fields, so existing clients (mobile, CLI)
keep working unchanged. The id is what lets a client tell two runs apart when
they share a booth timestamp — the booth supplies `updatedAt`, so `idle`, a
blip of `recording`, and `idle` again can all report the same millisecond, and
the two idle runs are otherwise indistinguishable. Ids increase with insertion
order, which is also how the API breaks those ties.

The operator console renders the count instead of the repeats
(`packages/web/src/lib/status-history.ts`):

- `mergeLiveStatus` replaces the head of the cached history when a WebSocket
  frame re-broadcasts the same collapsed row, instead of prepending a duplicate.
- `collapseStatusHistory` folds consecutive identical entries at render time so
  snapshots written before this change (and any client-side duplication) read
  the same as new history. The console fetches 200 raw snapshots and shows the
  first 50 collapsed statuses, so a pre-migration run of heartbeats cannot
  squeeze every genuine transition out of the panel.

## Consequences

- The status panel shows ~50 distinct booth statuses instead of ~50 heartbeats,
  each with a `×N` report count and a "since" time — the operator can see how
  long the booth has been idle and what actually happened.
- Snapshot growth is now proportional to transitions, not to uptime. The
  existing snapshot pruner still runs as a backstop.
- Reconciliation of stale call sessions ([ADR 0006](0006-reconcile-stale-call-sessions-on-idle.md))
  is unchanged: it still runs on every idle report, using the collapsed row's
  `updatedAt`.
- The collapse decision is a read-then-write, so concurrent PUTs that interleave
  between the read and the write can lose an increment, insert a duplicate row,
  or — if the two reports are applied out of order — leave the row's window at
  the earlier `updatedAt`. Serializing the decision would need a transaction
  with conflict retries. It isn't worth it here: the booth is a single writer
  pushing its status sequentially over one connection, so the interleaving needs
  a retried or duplicated request to happen at all, and the blast radius is a
  display window and a counter. The render-time collapse hides a duplicate row,
  and the next heartbeat corrects the window.
- A run's window is only as accurate as the order its reports arrive in. A
  _different_ status reported late enough to land inside an already-collapsed
  window is stored as its own row, but the enclosing run keeps its window, so
  the history briefly shows a run that spans a transition. Splitting the run
  would need per-report rows — exactly what the collapse exists to avoid — and
  the booth reports sequentially over one connection, so this needs a retried
  or reordered request to happen at all.
- Charts that plot one point per snapshot (the mobile status chart) now get one
  point per status rather than one per heartbeat. Consumers that need beat-level
  resolution should use booth events, which remain append-only.

## References

- `packages/api/src/routes/status.ts` — `isRepeatOf` and the collapsing PUT.
- `packages/api/prisma/migrations/20260728000000_collapse_repeated_status_snapshots`.
- `packages/web/src/lib/status-history.ts` — client-side merge and collapse.
- `packages/api/src/lib/snapshot-pruner.ts` — retention backstop.
