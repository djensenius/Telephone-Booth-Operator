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
