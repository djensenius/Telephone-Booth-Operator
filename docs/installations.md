# Installations

An **installation** is one run of the booth: a named era with a start, an end,
and a set of metadata (name, notes, location). It exists so the booth can be
torn down and set up again without last year's numbers polluting this year's
stats — and without throwing last year's numbers away.

At most one installation is active at a time — never two. There is briefly
none between ending an era and the booth's next write, which is normal rather
than a fault; see [Reading history](#reading-history).

> Why it works this way, and what was rejected:
> [ADR 0013](adr/0013-installations-as-data-scope.md).

## What is and isn't scoped

| Scoped to an installation | Survives a rollover                  |
| ------------------------- | ------------------------------------ |
| Messages                  | Instructions                         |
| Call sessions             | API tokens                           |
| Booth events              | Operators (and their metric filters) |
| Booth status snapshots    | Mobile devices                       |
| Questions                 |                                      |

The rule of thumb: **content is scoped, infrastructure is not.** Things you set
up once and keep (tokens, operator accounts, the greeting instructions) carry
over. Things the booth produced during a run belong to that run.

## Ending an installation

`POST /v1/installations/{id}/end` is the "archive everything, start fresh"
action. It is admin-only, runs in one transaction, and **deletes nothing**:

1. Stamps `endedAt` and who ended it.
2. Freezes the summary counters — calls, messages by status, recorded minutes,
   question count, and the first/last booth event (null if the era recorded
   none) — onto the row, so the history list renders without re-aggregating the
   event table.
3. Closes call sessions the booth never ended (power cut, crash mid-call) with
   outcome `installation_ended`.
4. Moves anything still in the moderation queue to a terminal state so the next
   era starts with an empty queue. The audio and transcripts are untouched and
   stay readable under the old installation's scope.
5. Archives the questions that were live, stamping `retiredAt` with the era's
   end time. Drafts are left alone.
6. Broadcasts an `installation` envelope on `/v1/ws/status` so connected
   consoles re-scope without a reload. Every console subscribes to this for as
   long as it is signed in, not just while the Status screen is open.

A caller can be midway through answering when an operator ends the era. That
recording still lands: a question retired _by a rollover_ stays answerable, and
the late message is filed under the era that is open when it arrives, where an
operator will actually see it in the queue. A question an operator retired by
hand is still refused — that is a deliberate withdrawal. Late `call_ended`
events are the mirror image: they are attributed to their session's era and can
never rewrite a closed era's outcome or frozen summary.

Starting one is also a rollover: `POST /v1/installations` first ends whichever
era is active, then creates the requested era in the same transaction. This
keeps a powered-on booth from blocking the operator by auto-opening an unnamed
era between the manual "end" and "start" steps. If no era is active, the new one
is simply created.

Two admins ending the same era at once is settled inside the transaction: the
first to claim it wins and the second gets `409`, so `retiredAt` and `endedAt`
never drift apart.

Nothing is deleted, so no backup is required to end an era — but
`GET /v1/installations/{id}/export` gives you a scoped tar whenever you want
one, and the Installations screen offers it per era.

## Starting a new one

`POST /v1/installations` opens a fresh era. It returns `409` if one is still
active — end the current one first.

`copyQuestions: true` carries the previous era's questions forward. A copy
points at the **same `File` row** as the original, so no audio is re-uploaded
and SHA-256 dedupe is preserved. This is why `Question.audioId` is not unique,
and why question prompts are unique _per installation_ rather than globally.
The checkbox is **off by default**; most new installations want a fresh set.

If the booth is powered on when you end an era, it keeps posting events, and a
booth write with no active installation lazily opens one — a recording must
never be dropped over admin bookkeeping. Starting a named installation
therefore **adopts** an active era that has no activity in it yet, rather than
failing. An era the booth has actually recorded into still returns `409`.

A recording that was already uploading when the era ended is left alone by the
close-out and re-filed into the open era when the booth calls
`POST /v1/messages/{id}/complete` — the same reasoning as a straggler recording
started after the rollover, and for the same reason: a finished recording must
not end up in a queue nobody is watching.

Copy-forward skips a prompt the new era already holds — prompts are unique per
installation, and an adopted era can already contain questions the operator
wrote before naming it.

Because the rollover archives an era's questions, resolving the prompts of a
historical message needs `GET /v1/questions?status=any` — the bare list hides
archived rows. Better still, pass the ids you already have:
`GET /v1/questions?ids=<comma-separated>` (up to 200) returns exactly those
questions whatever their era or status, which also covers a straggler message
filed against a newer era than the question that prompted it. The console does
this for you on the messages list and the message detail view.

## Reading history

Scoped collection, aggregate, and current-status endpoints take an optional
`installationId`:

| Value   | Scope                                     |
| ------- | ----------------------------------------- |
| omitted | the active installation (**the default**) |
| a uuid  | that historical installation              |
| `all`   | every installation                        |

This applies to `/v1/stats/*`, `/v1/messages`, `/v1/sessions`, `/v1/events`,
`/v1/questions`, `/v1/status`, and `/v1/status/history`.

Between ending an era and the booth's next write there is no active
installation. Reads in that window return an empty result rather than opening
a new era: only a booth write does that, so loading a screen never changes what
the booth is recording into.

An ended era is **read-only** for anything its frozen counters describe: the
API refuses a moderation decision or a delete on one of its recordings
(`409 installation_ended`), and the queue hides those actions when you are
browsing history. Playback, transcripts and exports are unaffected.

`installationId=all` spans open and closed eras at once, so the queue decides
row by row there: a recording belonging to a closed era is read-only even
though the rest of the page is not.

The same applies to a closed era's prompts: activating, deactivating or
archiving one is refused with `409`, because a prompt's `retiredAt` is the
marker that says it was live when the era ended, and a straggler recording is
matched against exactly that.

> **This changed the default.** Before installations existed, these endpoints
> meant "everything ever". They now mean "this run". Pass `installationId=all`
> for the old behaviour.

The `/installations` screen lists every era with its frozen summary and drills
into that era's stats, messages and calls. Messages, Sessions, Events and Stats each
carry a scope picker that round-trips through the URL, so a scoped view can be
linked and reloaded.

Late-arriving booth events are tagged with the era of the call session they
belong to, not with whatever era happens to be open. A `call_ended` that lands
after the rollover already closed its session leaves that session untouched: a
frozen era's summary always agrees with its own drill-down.

Every row is stamped with its era by the API, and by a database trigger if the
API somehow does not: an insert that arrives with no `installationId` — the
previous release still serving during a rollout, or a hand-written statement —
is filed into whichever era is open. Without it, writes made in the window
between running the migration and rolling out the new image would sit outside
every default-scoped read.

The active era's id is cached for a few seconds on each API replica. A start or
end invalidates the replica that served it immediately; other replicas pick up
the change when the cache lapses.

## Endpoints

```text
GET    /v1/installations             → every era, newest first
GET    /v1/installations/current     → the active era (404 if none)
GET    /v1/installations/:id
POST   /v1/installations             ← end active era, start a new one (admin)
PATCH  /v1/installations/:id         ← edit name/notes/location      (admin)
POST   /v1/installations/:id/end     ← close out the active era      (admin)
GET    /v1/installations/:id/export  → scoped tar archive            (admin)
DELETE /v1/installations/:id         ← irreversible hard purge       (admin)
```

## Hard purge

`DELETE /v1/installations/{id}` permanently destroys one era — its rows **and
its audio blobs**. There is no undo. It is available from the admin panel on
the Settings screen, next to backup and restore.

Guardrails:

- Admin-only.
- Refuses the **active** installation. End it first.
- Requires the caller to echo the installation's exact name in the request
  body (`{ "confirmName": "…" }`), or it returns `400 name_mismatch`.
- Audio is refcounted. A `File` still referenced by a surviving question,
  message, or instruction — for instance a question copied forward into the
  current era — is **retained**, along with its blob. Without this, purging an
  old era would silently mute a live booth.
- A recording still uploading into the era is moved to the era that is open
  rather than deleted, so the booth's completion call still lands. If no era is
  open to move it to, the purge is refused with `409 uploads_in_flight`; make a
  call, or wait for the booth to, and try again.
- The purge is recorded in the [audit log](audit-log.md) as
  `installation.purge`. That entry is global rather than era-scoped, so it
  outlives the rows it describes — after a purge it is the only record that the
  era existed. Starting, ending, and renaming an era are recorded too.

The scoped archive offered before a purge carries no audit rows: the trail spans
every era and names operators and their addresses, and this file is meant to be
handed around.

The response reports what happened:

```json
{
  "installationId": "…",
  "rows": { "events": 812, "messages": 96, "callSessions": 104, "questions": 12, "snapshots": 340 },
  "blobsDeleted": 104,
  "blobsRetained": 4,
  "blobFailures": []
}
```

Blob deletion runs after the database transaction commits. A blob that fails to
delete is listed in `blobFailures` rather than rolling the purge back — an
orphaned blob is wasteful but harmless.

**Take an export first.** `GET /v1/installations/{id}/export` gives you a
scoped tar; see [Backup & restore](backup-restore.md).

## Fresh-install checklist

Setting the booth up somewhere new:

1. `GET /v1/installations/{current}/export` — keep the tar somewhere safe.
2. End the current installation, adding a note about where it ran.
3. Start a new one with the venue in `location`. Tick **copy questions** only
   if you want the same prompts.
4. Confirm the Stats screen reads zero and the queue is empty.
5. API tokens, operators, and instructions still work — nothing to redo.
