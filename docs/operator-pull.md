# Pull-mode worker (Mac app polls Operator)

The original Mac transcription app (sibling repo
[`Telephone-Booth-Transcription`][tbt]) implements two ways to do work for
the Operator:

1. **Push** — Operator's `mac_app` providers call out to the Mac app's
   `POST /v1/audio/transcriptions` and `POST /v1/moderations` endpoints.
   Requires the Mac to be reachable from the Operator.
2. **Pull** — Mac app polls the Operator every few seconds, leases a job,
   runs it locally, and posts the result back. Requires the Mac to be able
   to make **outbound** HTTPS to the Operator (no inbound port needed).

This document is the contract for the pull path. The push path is unchanged
and is covered by `docs/transcription-providers.md`.

[tbt]: https://github.com/djensenius/Telephone-Booth-Transcription

## Endpoints

All four endpoints live under `/v1/jobs/*` and authenticate with the same
bearer-token scheme phone clients use (`requireApiToken`). Mint a token via
`POST /v1/api-tokens` and store it in the Mac app's Keychain.

| Method | Path                          | Purpose                                    |
| ------ | ----------------------------- | ------------------------------------------ |
| GET    | `/v1/jobs/next`               | Lease the next pending job                 |
| POST   | `/v1/jobs/{id}/heartbeat`     | Extend the lease on a long-running job     |
| POST   | `/v1/jobs/{id}/succeed`       | Submit a successful result                 |
| POST   | `/v1/jobs/{id}/fail`          | Report a failure (sanitized error code)    |

The wire shapes are in `packages/api/openapi.yaml` under tag `jobs`.

## Concurrency model: claim-with-lease

`GET /v1/jobs/next` atomically claims the oldest eligible pending row of
each requested kind:

1. Caller may filter the kinds it can handle:
   `?kinds=transcription,translation,moderation` (default = all three).
2. Server picks the oldest unleased (or expired-lease) candidate, mints a
   fresh `leaseToken`, and bumps `attemptCount`.
3. Response includes the `leaseToken` plus the job payload. Worker holds
   the lease for `leaseSeconds` (default 60 s, max 3600 s).
4. The worker submits `/succeed` or `/fail` with the same `leaseToken`. If
   the lease has been stolen (token mismatch or the row is no longer
   pending), the server returns `409 lease_lost` and the worker drops the
   result.

After **5 failed attempts** the row is marked terminally `failed`; the
`/fail` response includes `terminal: true`. For terminal moderation
failures the message is also nudged from `received` → `pending` so a
human operator can still review it.

## Job kinds

Job IDs are `{kind}-{rowId}` — opaque to the worker; just echo them back.

### `transcription`

```json
{
  "id": "transcription-abc…",
  "kind": "transcription",
  "leaseToken": "…",
  "attempt": 1,
  "transcription": {
    "messageId": "…",
    "audioUrl": "https://…?sp=r&se=…",
    "sha256": "…",
    "durationMs": 4200,
    "contentType": "audio/flac",
    "filename": "ab…ef.flac",
    "model": null,
    "language": null
  }
}
```

The `audioUrl` is a short-lived SAS to the FLAC in Azure Blob Storage. The
Operator never streams audio through itself — the worker pulls it directly.

`POST /v1/jobs/{id}/succeed` body:

```json
{
  "leaseToken": "…",
  "text": "transcribed text",
  "language": "en",
  "model": "faster-whisper-tiny"
}
```

On success, the Operator:

- writes `text` / `language` / `model` onto the transcription row;
- if `language` is non-English, marks `translationStatus = "pending"` so the
  next `/v1/jobs/next?kinds=translation` poll picks it up;
- creates a pending `moderation` row (the worker leases this next);
- if the recording is silent (`text` empty), nudges the message to
  `pending` so it appears in the operator queue immediately.

### `translation`

```json
{
  "id": "translation-abc…",
  "kind": "translation",
  "leaseToken": "…",
  "attempt": 1,
  "translation": {
    "messageId": "…",
    "transcriptionId": "abc…",
    "text": "Bonjour",
    "sourceLanguage": "fr",
    "targetLanguage": "en",
    "model": null
  }
}
```

The worker calls its own translation upstream (LM Studio chat, OpenAI, etc.)
and submits:

```json
{
  "leaseToken": "…",
  "translatedText": "Hello",
  "sourceLanguage": "fr",
  "targetLanguage": "en",
  "model": "gpt-4o-mini"
}
```

The translated text replaces the original wherever the operator UI displays
content; moderation runs against translated text when present.

### `moderation`

Moderation jobs are **only leasable once their linked transcription's
translation step is no longer pending**. This guarantees the moderator sees
the same English copy the auto-decision will be applied to.

```json
{
  "id": "moderation-abc…",
  "kind": "moderation",
  "leaseToken": "…",
  "attempt": 1,
  "moderation": {
    "messageId": "…",
    "transcriptionId": "abc…",
    "text": "Hello",
    "model": null
  }
}
```

Worker submits:

```json
{
  "leaseToken": "…",
  "flagged": false,
  "recommendation": "approve",
  "maxScore": 0.02,
  "categories": { "hate": 0.01, "violence": 0.0 },
  "reasonSummary": "no policy hits",
  "model": "llama-guard-3"
}
```

The Operator persists the result and applies its configured auto-decision
to the parent message (`approve` / `review` / `reject`), then broadcasts
the change over the WebSocket so live operator UIs update instantly.

## Failure handling

- `409 lease_lost` — discard the result. Either the lease expired and was
  stolen, or the row was already finalized by another worker.
- `404 not_found` — the row was deleted (e.g. message purged). Stop trying.
- Transport errors — retry with capped backoff. Heartbeat the lease if the
  job will take longer than the lease window.
- After 5 attempts the Operator marks the row permanently failed.

## Privacy

The Operator stores **only metadata** in the `RequestLog`-equivalent paths;
it never logs audio bytes or transcribed text. The Mac app applies the same
discipline on its side (see [Telephone-Booth-Transcription `docs/moderation.md`][modlog]).

[modlog]: https://github.com/djensenius/Telephone-Booth-Transcription/blob/main/docs/moderation.md

## Coexistence with the push path

Both modes can be live at once. The push providers (`mac_app` transcription
/ moderation) call the Mac app directly when configured; the pull worker
leases whatever rows are still pending. The lease mechanism means two
workers sharing the queue is safe — the loser of any race just gets the
next row on its next poll.
