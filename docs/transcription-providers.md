# Transcription and moderation providers

Every completed booth recording is run through two AI steps:

1. **Transcription** — converts the audio blob into text.
2. **Moderation** — runs the transcript through a content classifier
   and produces a recommendation (`approve`, `review`, or `reject`).

Both steps are persisted per message (full history is kept) and surfaced
on the operator UI. The pipeline runs automatically when the booth
finishes uploading, and operators can re-run either step from the
message detail screen.

Architecture rationale lives in [ADR 0005](./adr/0005-ai-transcription-and-moderation.md).

## Configuration

All settings live in environment variables. See `.env.example` for the
authoritative list.

| Variable                      | Default                  | Description                                               |
| ----------------------------- | ------------------------ | --------------------------------------------------------- |
| `TRANSCRIPTION_PROVIDER`      | `disabled`               | `openai`, `mac_app`, `push`, or `disabled`.               |
| `TRANSCRIPTION_OPENAI_MODEL`  | `whisper-1`              | Model passed to `/v1/audio/transcriptions`.               |
| `TRANSCRIPTION_MAC_APP_URL`   | _empty_                  | Base or full URL for OpenAI-compatible Mac transcription. |
| `TRANSCRIPTION_MAC_APP_TOKEN` | _empty_                  | Optional bearer token for the Mac app.                    |
| `MODERATION_PROVIDER`         | `disabled`               | `openai`, `mac_app`, `push`, or `disabled`.               |
| `MODERATION_OPENAI_MODEL`     | `omni-moderation-latest` | Model passed to `/v1/moderations`.                        |
| `MODERATION_MAC_APP_URL`      | _empty_                  | Base or full URL for OpenAI-compatible Mac moderation.    |
| `MODERATION_MAC_APP_TOKEN`    | _empty_                  | Optional bearer token for the Mac app.                    |
| `OPENAI_API_KEY`              | _empty_                  | Shared key for both OpenAI endpoints.                     |
| `OPENAI_BASE_URL`             | `https://api.openai.com` | Override for self-hosted OpenAI-compatible APIs.          |
| `MODERATION_REJECT_THRESHOLD` | `0.85`                   | Score at/above which the AI _suggests_ `reject`.          |
| `MODERATION_APPROVE_THRESHOLD`| `0.15`                   | Score at/below which the AI _suggests_ `approve`.         |
| `AI_SWEEPER_INTERVAL_SECONDS` | `60`                     | How often the recovery sweeper retries stuck messages.    |

A provider with `disabled` selected, or with credentials missing, is a
no-op — the pipeline writes a `failed` row with `error = "disabled"` and
continues. This is the safe default for local development.

## Push mode (`push`)

Setting a provider to `push` inverts the flow: no in-process provider runs.
Instead the Transcription app (macOS + iOS) subscribes to `/v1/ws/status`,
reacts to `{kind:"work", needs}` envelopes, runs the step locally, and POSTs
the result back to `/v1/worker/*`. Transcription steps land as a `pending` row
plus a broadcast `work` event rather than a `failed` row. See
[`operator-push.md`](./operator-push.md) for the full contract. Unlike
`mac_app` (Operator → app push-in), `push` needs no inbound reachability to
the app.

## OpenAI

Set:

```env
TRANSCRIPTION_PROVIDER=openai
MODERATION_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

- Transcription POSTs the recording (downloaded server-side via the
  short-lived SAS URL) as multipart to
  `${OPENAI_BASE_URL}/v1/audio/transcriptions` with
  `response_format=verbose_json`.
- Moderation POSTs `{ input: <transcript> }` to
  `${OPENAI_BASE_URL}/v1/moderations`.

A `recommendation` is derived from the response: `flagged === true` or
`maxScore >= MODERATION_REJECT_THRESHOLD` maps to `reject`,
`maxScore <= MODERATION_APPROVE_THRESHOLD` maps to `approve`, otherwise
`review`. This recommendation is **only an advisory suggestion** shown to the
operator — the Operator never auto-approves or auto-rejects a message. Every
message waits in the queue until a human decides via
`POST /v1/messages/:id/decision`.

## Mac app

The Mac app in the
[`Telephone-Booth-Transcription`](https://github.com/djensenius/Telephone-Booth-Transcription)
repo exposes OpenAI-compatible HTTP endpoints. The operator reuses the same
wire shapes as the OpenAI providers, with an optional bearer token from the
matching `*_MAC_APP_TOKEN` variable.

Set:

```env
TRANSCRIPTION_PROVIDER=mac_app
MODERATION_PROVIDER=mac_app
TRANSCRIPTION_MAC_APP_URL=http://127.0.0.1:8089
MODERATION_MAC_APP_URL=http://127.0.0.1:8089
TRANSCRIPTION_MAC_APP_TOKEN=...  # optional
MODERATION_MAC_APP_TOKEN=...     # optional
```

`*_MAC_APP_URL` may be either the app's base URL or the full endpoint URL.
If the Transcription host binds to a non-loopback address, its settings must
explicitly acknowledge that by setting `nonLoopbackBindAcknowledged=true`.

### Transcription contract

The operator downloads the recording from its short-lived SAS URL, enforces
`MAX_AUDIO_BYTES`, then `POST`s multipart/form-data to
`{TRANSCRIPTION_MAC_APP_URL}/v1/audio/transcriptions` (or the full URL if one
was configured). The multipart body contains the `file` part and
`response_format=verbose_json`; a `model` part is sent only when a mac-app
provider model is configured by code.

Expected response (HTTP 200):

```json
{
  "text": "Hello world",
  "language": "en"
}
```

`language` is optional. Non-2xx responses are recorded as a `failed`
transcription without persisting the upstream response body.

### Moderation contract

The operator `POST`s OpenAI-shaped JSON to
`{MODERATION_MAC_APP_URL}/v1/moderations` (or the full URL if one was
configured):

```json
{ "input": "Hello world" }
```

Expected response:

```json
{
  "id": "modr-local-...",
  "model": "omni-moderation-latest",
  "results": [
    {
      "flagged": false,
      "categories": { "hate": false, "violence": false },
      "category_scores": { "hate": 0.01, "violence": 0.0 }
    }
  ]
}
```

The operator derives `recommendation`, `maxScore`, and stored category scores
using the same threshold logic as the OpenAI moderation provider.

## Moderation is advisory — humans always decide

The pipeline runs after both steps succeed. Once moderation finishes, the
pipeline advances the message from `received` to `pending` so it shows up in the
operator review queue. It **never** auto-approves or auto-rejects: the AI
moderation result (`flagged`, `recommendation`, `maxScore`, category scores) is
stored purely as an advisory suggestion.

Every message is decided by a human operator via
`POST /v1/messages/:id/decision` from any operator app (web, mobile, or the CLI
TUI). The decision stamps `decidedById` (the acting operator) and `decidedAt`;
an AI suggestion never sets those fields.

## Operator UI

- **Messages list** — adds a transcript-snippet column (clamped) and a
  colour-coded moderation badge per row.
- **Message detail** — shows a transcript card with provider + language,
  a moderation card with categories and reason, "Re-run transcription"
  and "Re-run moderation" buttons, and a history disclosure listing
  prior attempts.

The WebSocket at `/v1/ws/status` broadcasts a `kind:"message"` envelope
after every transcription or moderation row change, so the UI updates
without polling.

## Re-running from the API

```http
POST /v1/messages/{id}/transcribe
POST /v1/messages/{id}/moderate
GET  /v1/messages/{id}/transcriptions
```

`transcribe` re-runs the full pipeline (transcription + translation +
moderation). `moderate` only re-runs the moderation step against the
latest succeeded transcription. Moderation is advisory only — neither
endpoint decides the message; a human approves/rejects via
`POST /v1/messages/:id/decision`. `transcriptions` returns the full
history of attempts.

## Cost and privacy

- Transcripts may contain personal information. The API logs only an
  80-character preview at info level — the full text never appears in
  logs.
- Every `received` message hits the configured provider once. The
  `disabled` default protects non-production environments from accidental
  spend.
- SAS URLs scoped to a single blob are used for the OpenAI fetch; their
  default 15-minute TTL is comfortable even for slow transcription
  paths.
