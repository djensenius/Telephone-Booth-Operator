# Installations

An **installation** is one run of the booth: a named era with a start, an end,
and a set of metadata (name, notes, location). It exists so the booth can be
torn down and set up again without last year's numbers polluting this year's
stats — and without throwing last year's numbers away.

Exactly one installation is active at a time.

> Why it works this way, and what was rejected:
> [ADR 0011](adr/0011-installations-as-data-scope.md).

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
   question count, first/last activity — onto the row, so the history list
   renders without re-aggregating the event table.
3. Closes call sessions the booth never ended (power cut, crash mid-call) with
   outcome `installation_ended`.
4. Moves anything still in the moderation queue to a terminal state so the next
   era starts with an empty queue. The audio and transcripts are untouched and
   stay readable under the old installation's scope.
5. Archives the questions that were live, stamping `retiredAt` with the era's
   end time. Drafts are left alone.
6. Broadcasts an `installation` envelope on `/v1/ws/status` so connected
   consoles re-scope without a reload.

A scoped archive is built **before** any of this and offered as a download. If
the archive can't be built the whole operation aborts with `503` — the books
don't get closed without a backup.

## Starting a new one

`POST /v1/installations` opens a fresh era. It returns `409` if one is still
active — end the current one first.

`copyQuestions: true` carries the previous era's questions forward. Copies
point at the **same blob**: `Question.audioId` is unique, so the copy gets its
own `File` row referencing the identical `blobKey`. No audio is re-uploaded and
SHA-256 dedupe is preserved. The checkbox is **off by default**; most new
installations want a fresh set.

## Reading history

Every list and aggregate endpoint takes an optional `installationId`:

| Value   | Scope                                     |
| ------- | ----------------------------------------- |
| omitted | the active installation (**the default**) |
| a uuid  | that historical installation              |
| `all`   | every installation                        |

This applies to `/v1/stats/*`, `/v1/messages`, `/v1/sessions`, and `/v1/events`.

> **This changed the default.** Before installations existed, these endpoints
> meant "everything ever". They now mean "this run". Pass `installationId=all`
> for the old behaviour.

The `/installations` screen lists every era with its frozen summary and drills
into scoped stats for any of them.

## Endpoints

```text
GET    /v1/installations             → every era, newest first
GET    /v1/installations/current     → the active era (404 if none)
GET    /v1/installations/:id
POST   /v1/installations             ← start a new era               (admin)
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
- Blobs are refcounted by `blobKey`. A blob shared with a surviving `File` row
  — for instance a question copied forward into the current era — is
  **retained**. Without this, purging an old era would silently mute a live
  booth.

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
