# Claimed on-device message processing

OIDC-authenticated operator apps that can process recordings locally should
claim work after sign-in and whenever their local processing queue becomes
idle. This is separate from the static worker-token push callbacks described
in [operator-push.md](./operator-push.md); those routes remain supported for
dedicated workers.

Only the current installation is processable. Ended installations remain
read-only, so an in-flight result submitted after a rollover receives
`409 installation_ended`.

## Contract

All endpoints require an operator cookie session or OIDC bearer token.

| Method | Path                                    | Purpose                                                   |
| ------ | --------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/v1/message-processing/summary`        | Current-installation queue counts                         |
| `POST` | `/v1/message-processing/claim`          | Atomically lease one compatible message                   |
| `POST` | `/v1/message-processing/{id}/heartbeat` | Extend an active lease                                    |
| `POST` | `/v1/message-processing/{id}/complete`  | Store locally computed results and release                |
| `POST` | `/v1/message-processing/{id}/fail`      | Release after an error; becomes terminal after 3 attempts |
| `POST` | `/v1/message-processing/{id}/release`   | Voluntarily release a lease                               |

`POST /claim` accepts optional `capabilities` (`transcription`, `translation`,
`moderation`, `review`) and a 30–900 second `leaseSeconds` value. It returns
`{"claim": null}` when no compatible work is available. Otherwise it returns
the hydrated `Message` (including its short-lived audio URL), missing `needs`,
an opaque `leaseToken`, lease expiry, and the nullable installation
`defaultTranscriptionLanguage`.

The server stores only a SHA-256 digest of the lease token. Claiming uses a
row lock plus conditional update on the current message lease, so two devices
cannot hold the same message concurrently. The queue scan pages past completed
or incompatible older rows rather than starving newer eligible work. Expired
leases are eligible again. A failed lease increments the message attempt
counter; the third failure is terminal and is surfaced by `summary.terminal`
instead of being retried forever.

`summary` returns `queued`, `leased`, `terminal`, and per-step `needs` counts.
`queued` and `leased` count messages, while `needs` counts outstanding steps.

## Result handling and no-speech recordings

`POST /complete` accepts one or more of `transcription`, `translation`,
`moderation`, and `review`, plus the lease token. It delegates transcript,
translation, and moderation writes to the same stale-safe paths used by the
existing message routes. The server binds every lease to the claimed
processing snapshot and validates it under the message lock before accepting a
result, so existing clients do not need to send a new snapshot field. A result
superseded after the claim returns `409 claim_snapshot_stale`; a lost or
expired lease returns `409 lease_lost`. The entire result set is atomic:
validation failure in one component rolls back every component in that
submission.

For the conservative v1 client rule, a device evaluates audio locally:

- no speech and duration at most 3000 ms: send an empty transcription plus
  `review: {"classification":"likely_hangup","recommendation":"delete"}`;
- no speech and longer than 3000 ms: send an empty transcription plus
  `review: {"classification":"unclear","recommendation":"review"}`.

No transcript text is invented for either case. The classification and
recommendation are persisted on the message and displayed as advisory. The
server **never** deletes a recording based on this recommendation; existing
`DELETE /v1/messages/{id}` semantics remain the explicit destructive action.

## Installation transcription language

Administrators can set `defaultTranscriptionLanguage` while creating or
editing an installation. It is nullable and validated as a BCP-47 language
tag (for example `en`, `en-CA`, `en-u-ca-gregory`, or `x-private`). The API
canonicalizes its casing. A claim echoes the current value so devices can
choose it as their transcription default.

## Multi-replica updates

Message envelopes are delivered immediately to WebSocket subscribers connected
to the handling API replica. The web console also refreshes message lists,
details, transcription history, and processing counts every five seconds, so a
console attached to another replica converges promptly if it misses that
process-local envelope.

## Statistics

In `/v1/stats/overview`, `messages.total` and the explicit
`messages.approved` count only approved, playable messages. `allRecordings`
and `byStatus` expose the complete recording population. Message average
duration, hourly message buckets, and top-question counts use the approved
subset. The default stats scope remains the active installation; a UUID and
`installationId=all` continue to work.

Frozen summaries from before these labels changed are normalized on read:
their legacy `messages` total becomes `allRecordings`, while
`messagesApproved` becomes the playable `messages` value.
