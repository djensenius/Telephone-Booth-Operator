# Push-mode worker (Mac/iOS app subscribes to the Operator)

The Transcription app (sibling repo
[`Telephone-Booth-Transcription`][tbt], **macOS and iOS**) does work for the
Operator without needing any inbound reachability. It **subscribes** to the
Operator's status WebSocket, is told which messages need work, runs the step
locally, and **pushes the result back**. This replaced the earlier
`/v1/jobs/*` pull/lease queue (see [ADR 0009](./adr/0009-human-moderation-and-push-worker.md)).

There is no auto-decision anywhere in this flow: moderation results are only
an **advisory suggestion**. A human operator always decides a message via
`POST /v1/messages/:id/decision`.

[tbt]: https://github.com/djensenius/Telephone-Booth-Transcription

## Overview

```text
Booth uploads message ──► Operator persists (status: received)
        │  broadcast WS {kind:"work", messageId, needs:["transcription"]}
        ▼
Transcription app (WS subscriber, API-token auth; macOS + iOS)
        │  GET  /v1/worker/messages/:id/work      (fetch audio SAS / transcript)
        │  …runs transcription locally…
        ▼  POST /v1/worker/messages/:id/transcription
Operator stores it; broadcasts needs:["translation"] (non-English) or
                                    needs:["moderation"] (English)
        ▼  …translation pushed back… then…
        ▼  POST /v1/worker/messages/:id/moderation   (ADVISORY suggestion)
Operator records the suggestion, advances received → pending. A human
operator (web / mobile / CLI) reviews and calls POST /v1/messages/:id/decision.
```

## Authentication

The worker authenticates with a **worker-scoped** static Argon2id API token —
not the generic operator/phone token. Mint one via `POST /v1/api-tokens` with
`{"scope": "worker"}` (or pick **Worker** in the operator UI → Tokens), and
store it in the app's Keychain.

A worker-scoped token is least-privilege: it may call only the `/v1/worker/*`
callbacks and, on the status WebSocket, receives **only** `work` events — never
message content (audio SAS URLs, transcripts, moderation). It cannot access the
booth/phone routes. Conversely, an operator-scoped token is rejected from
`/v1/worker/*` with `403 insufficient_scope` and never sees `work` events.

- **WebSocket:** connect to `/v1/ws/status` with an
  `Authorization: Bearer <token>` header. The upgrade authorizer accepts
  a browser session cookie, an Authentik bearer, **or** a valid API token; a
  worker-scoped token is classified as a worker connection and filtered to
  `work` events only.
- **Callbacks:** the `/v1/worker/*` endpoints require a `worker`-scoped API token.

## The `work` envelope

The status WebSocket multiplexes several envelope kinds. The worker reacts to:

```json
{ "kind": "work", "messageId": "…", "needs": ["transcription"] }
```

`needs` is one or more of `transcription`, `translation`, `moderation`. The
envelope carries **no** audio URL or secrets — the status channel is shared
with browser operators, so nothing sensitive is broadcast there. The worker
fetches what it needs over its own authenticated connection.

The Operator emits `work` when a step becomes runnable, and re-emits it on the
crash-recovery sweep, so a reconnecting worker catches up.

## Endpoints

All under `/v1/worker/*` (tag `worker` in `packages/api/openapi.yaml`),
API-token authenticated. Unlike the old pull queue there are **no leases**:
callbacks finalize only existing pending push rows, and every write is guarded
so a stale or duplicate callback can never create a newer row or downgrade an
already-finalized row.

| Method | Path                                          | Purpose                                     |
| ------ | --------------------------------------------- | ------------------------------------------- |
| GET    | `/v1/worker/messages/{id}/work`               | Fetch work inputs (audio SAS + transcript)  |
| POST   | `/v1/worker/messages/{id}/transcription`      | Push a transcription result                 |
| POST   | `/v1/worker/messages/{id}/translation`        | Push a translation result                   |
| POST   | `/v1/worker/messages/{id}/moderation`         | Push a moderation **suggestion**            |

### `GET /v1/worker/messages/{id}/work`

Returns the current inputs the worker needs. The `audio.url` is a short-lived
read-only SAS to the FLAC in Azure Blob Storage — the Operator never streams
audio through itself.

```json
{
  "id": "…",
  "status": "received",
  "audio": {
    "url": "https://…?sp=r&se=…",
    "sha256": "…",
    "durationMs": 4200,
    "contentType": "audio/flac",
    "filename": "ab…ef.flac"
  },
  "transcription": {
    "id": "abc…",
    "text": "Bonjour",
    "language": "fr",
    "model": null,
    "translationStatus": "succeeded",
    "translatedText": "Hello",
    "moderationText": "Hello"
  }
}
```

`transcription` is `null` before the first transcription. `moderationText` is
the English translation when available, otherwise the original transcript —
it is exactly the text the moderation step should score.

### `POST /v1/worker/messages/{id}/transcription`

```json
{ "text": "transcribed text", "language": "en", "model": "faster-whisper-tiny" }
```

On success the Operator writes the transcription, then:

- if `language` is non-English, marks `translationStatus = "pending"` and
  broadcasts `needs:["translation"]`;
- otherwise creates the pending moderation row and broadcasts
  `needs:["moderation"]`;
- if the recording is silent (`text` empty), nudges the message to `pending`
  so it appears in the operator queue immediately (no translation/moderation).

> **Always send `language`.** A missing / null `language` is treated as
> English, which **skips translation** and moderates the original text. If
> your provider doesn't emit a language tag, supply an explicit best-guess
> BCP-47 code so the Operator routes the row through translation correctly.

### `POST /v1/worker/messages/{id}/translation`

```json
{
  "transcriptionId": "abc…",
  "translatedText": "Hello",
  "sourceLanguage": "fr",
  "targetLanguage": "en",
  "model": "gpt-4o-mini"
}
```

The translated text replaces the original wherever the operator UI shows
content; moderation runs against it. On success the Operator broadcasts
`needs:["moderation"]`.

### `POST /v1/worker/messages/{id}/moderation`

```json
{
  "transcriptionId": "abc…",
  "flagged": false,
  "recommendation": "approve",
  "maxScore": 0.02,
  "categories": { "hate": 0.01, "violence": 0.0 },
  "reasonSummary": "no policy hits",
  "model": "llama-guard-3"
}
```

`recommendation` is `approve` | `review` | `reject`. This is **advisory only**:
the Operator records the suggestion and advances `received` → `pending`, but
**never** auto-approves or auto-rejects. It then broadcasts a `kind:"message"`
envelope so live operator UIs update instantly, and a human decides via
`POST /v1/messages/:id/decision`.

## Failure handling

- `404 not_found` — the message or transcription was deleted (e.g. purged).
  Stop trying.
- Transport errors — reconnect the WebSocket with capped backoff; the Operator
  re-emits outstanding `work` on its recovery sweep, so nothing is lost.
- There are no leases and no lease-lost errors: a late callback is simply
  ignored by the finalized-row guards.

## Idempotency / multiple workers

Without leases there is no mutual exclusion. For the single-speaker
installation one worker is expected. If several subscribe they may each run
the same message; the write guards keep the stored result consistent, at the
cost of duplicated local compute. See [ADR 0009](./adr/0009-human-moderation-and-push-worker.md).

## Privacy

The Operator stores transcribed text in `Transcription.text`, but logs only
metadata; it never logs audio bytes or transcribed text. The Transcription app
applies the same discipline (see
[Telephone-Booth-Transcription `docs/moderation.md`][modlog]).

[modlog]: https://github.com/djensenius/Telephone-Booth-Transcription/blob/main/docs/moderation.md
