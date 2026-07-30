# ADR 0011 — Installations as the data scope

**Status:** accepted.

## Context

The booth is an art installation that gets set up, run for a while, torn down,
and then set up again somewhere else. The database had no notion of "this run".
Every `Message`, `CallSession`, `BoothEvent`, `BoothStatusSnapshot`, and
`Question` accumulated into one undifferentiated pile.

That caused two problems:

1. **Stats never reset.** After a teardown, the next run's call counts,
   recording minutes, and moderation queue all inherited whatever the previous
   run left behind. There was no honest way to answer "how did this weekend
   go?".
2. **There was no history.** The only reset mechanism was
   `GET /v1/admin/data/export` plus manual database surgery, and the only way to
   look at an old run was to restore its archive into a throwaway instance.

The obvious fix — a "clear everything" button that deletes rows — solves (1) by
making (2) permanently worse.

## Decision

Introduce an **`Installation`**: a named, timestamped era of the booth. Exactly
one is active at a time, enforced in the database by a partial unique index:

```sql
CREATE UNIQUE INDEX "Installation_single_active_idx"
  ON "Installation" ((1)) WHERE "endedAt" IS NULL;
```

Time-series data carries an `installationId`. **Clearing is a scope change, not
a delete.** Ending an installation freezes its summary counters, closes out
sessions the booth never ended, empties the moderation queue, and retires its
questions — but deletes nothing. Starting a new one opens a fresh scope, and
every default-scoped read immediately reports zero.

### Consequence: the default read scope changed

This is the risky part and it is deliberate. `/v1/stats/*`, `/v1/messages`,
`/v1/sessions`, and `/v1/events` used to mean "everything ever". They now mean
"the active installation". The `installationId` query param controls this:

| Value   | Scope                                                |
| ------- | ---------------------------------------------------- |
| omitted | the active installation (**new default**)            |
| a uuid  | that historical installation                         |
| `all`   | every installation — the pre-installations behaviour |

`installationId=all` is the documented escape hatch for anyone who wants the
old numbers back. Existing archives restore fine: the backfill migration
assigns every pre-existing row to a seeded "Installation 1".

### Consequence: a booth write must never fail on bookkeeping

`requireActiveInstallation()` lazily creates a default installation when none
exists rather than rejecting the write. A missing admin record is not a good
reason to drop somebody's recording.

The cost is a race: a booth that is powered on will open an unnamed era within
seconds of the operator ending one, so naming the next era would always collide.
Starting an installation therefore adopts an active era with no activity in it
instead of returning `409`. Only an era the booth has actually recorded into is
treated as a genuine conflict.

### Accepted: two write paths stay unserialised

The paths that decide where a _durable, operator-visible_ row lives take the
era lock described below: booth events and the sessions they open, prompt
creation, and promoting a finished recording out of `uploading`. Two do not.

A booth status snapshot resolves the active era without a lock. It is a
sample of a live signal, and one landing on either side of a rollover changes
nothing an operator acts on.

A recording row created at the start of an upload is likewise unlocked, because
its era is not settled yet: `POST /v1/messages/{id}/complete` takes the lock and
files the finished recording into an era that is definitely open. Locking the
row twice would buy nothing.

What is _not_ accepted is a straggler mutating an era after it was frozen. A
`call_ended` for a session the rollover already closed does not take the update
arm — the update is conditional in the database on the session's era still
being open, so a rollover committing between the check and the write is still
refused, and booth events are tagged with the era of the session they belong to
rather than whichever era is open. An ended era therefore always agrees with
its own drill-down for anything the operator acts on: sessions, the moderation
queue, and questions.

The frozen `summary.events` count is the one exception. A straggler event for a
closed era's session is filed with that session, so the era's event drill-down
can gain a row after its counters were frozen. We keep it that way: the
alternative is either misattributing the event to an era the booth was not
recording into, or recomputing a frozen summary, which would defeat the point
of freezing it. The drift is bounded by the seconds-long window around a
rollover and only affects a raw event tally.

### Writes are serialised against the rollover by the era row itself

Re-reading the era is not enough on its own. Under Postgres MVCC a reader
cannot see a rollover that has run its close-out but has not yet committed, so
a write can always slip in behind one that is mid-flight. The fix is the era
row: a write takes `SELECT … FOR SHARE` on its `Installation` for the length of
its transaction, and the close-out takes `FOR UPDATE`. Shared locks do not
conflict with each other, so ordinary concurrent writes are unaffected; only in
the moment an era is actually ending do the two queue up. Whichever arrives
second sees the other's committed work, and a writer that finds its era closed
resolves the open one and takes its lock instead.

This covers the three paths where the ordering matters: creating a prompt,
promoting a finished upload out of `uploading`, and opening a call session.
The last one matters most — a session created inside an era that is being
frozen would never be closed, and its own `call_ended` would afterwards be
refused as a straggler.

What the lock does _not_ do is change which era a write belongs to. A recording
that commits before the close-out is drained by it, exactly as it should be;
one that arrives afterwards lands in the era that is open.

### Accepted: a purged blob key can be reused mid-purge

A hard purge deletes the `File` rows an era owned that nothing else references,
then deletes their blobs. Recordings are content-addressed, so a booth upload
of identical audio can recreate a row for a key the purge is still working
through. The purge re-checks each key immediately before deleting its blob and
leaves a resurrected one alone, which closes all but the window between that
check and the storage call.

Closing that last window needs a tombstone or lease on the blob key that the
upload path honours — a storage-layer protocol, not a query. It is not worth it
here: a purge is admin-gated, rare, and explicitly destructive, and the residual
failure is one recording whose blob has to be re-uploaded.

### Reads never open an era

Only a booth write lazily creates an installation. Between an era ending and
the booth's next write, scoped reads match nothing rather than resolving
through the write path — loading a screen must not change what the booth is
recording into.

### Why `installationId` is nullable

The column is nullable but always populated at write time. Nullable avoids a
full table rewrite on a non-empty production database during the migration; the
backfill then assigns every existing row. Making it `NOT NULL` later is a
follow-up that costs a lock we did not want to take during a run.

### Deliberately global: `BoothEvent` idempotency

`BoothEvent` keeps its global `@@unique([boothId, eventId])` rather than scoping
it per installation, so an event replayed by the booth across a rollover stays
deduplicated.

## Hard purge

Scope-not-delete is the right default, but "we demoed with a fake dataset,
destroy it" is a real need. `DELETE /v1/installations/{id}` is the escape hatch:
admin-only, refuses the active installation, and requires the caller to echo the
installation's exact name.

It deletes blobs too, which is where it gets interesting. Questions copied
forward into a new era **share the original `File` row**, because audio is
content-addressed by SHA-256 and we do not want to re-upload it. That is why
`Question.audioId` is not unique and why `Question.prompt` is unique per
installation rather than globally. The purge therefore refcounts: a `File` still
referenced by a surviving question, message, or instruction is retained, and
only genuinely orphaned files (and their blobs) are deleted. Without that check,
purging an old era would silently mute a live booth.

Blob deletion runs after the database transaction commits. A partial blob
failure is reported in the response rather than rolled back — an orphaned blob
is wasteful but harmless, whereas rolling back an already-committed row delete
is not possible.

The purge deletes children before the era row, which is not atomic against a
straggler write. A booth event or recording that lands between a table's delete
and the parent delete survives with its `installationId` nulled by the
`ON DELETE SET NULL` foreign key, and its audio is not considered for blob
cleanup. We accept that: purging is an explicit, name-confirmed admin act on an
era that ended, so a booth still writing into it is already a misconfiguration,
and the residue is a handful of unscoped rows rather than a corrupt state.
Closing the window properly needs writer-side locking on the era, which is a
cost every call would pay for a case that should not happen.

## Alternatives considered

- **Delete on reset.** Simplest, and what was originally asked for. Rejected
  because it makes the history question unanswerable, and because a mis-clicked
  reset would be unrecoverable.
- **Archive to a separate database or a cold tar, then truncate.** This is
  effectively today's export flow. Rejected because browsing an old run then
  requires a restore, which is far too much friction for "how did last summer
  go?".
- **A `startedAt` cutoff instead of a foreign key.** Cheap — no schema change on
  the time-series tables — but every query becomes a date-range join against the
  installation table, gaps and overlaps become representable, and re-imported
  rows with older timestamps land in the wrong era.
- **Soft-delete flag on each row.** Scoping without the entity. Rejected: it
  gives you "hidden" but not "which run", so history is still unbrowsable.

## Consequences

- Stats caches must include the scope in their cache key, or a rollover serves
  the previous era's numbers until the TTL expires.
- Every new time-series model needs an `installationId` and a write path that
  stamps it. `lib/installation.ts` is the single place that resolves scope.
- The Rust booth client is unaware of installations. It keeps posting to the
  same endpoints and the API assigns the scope server-side, so this change is
  repo-local.
- Instructions, API tokens, operators, metric filters, and mobile devices are
  **not** scoped — they are infrastructure that survives a teardown.
