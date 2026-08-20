# BUSY Bar companion monitor

The physical BUSY Bar display runs as the standalone
[Telephone-Booth-Busy-Bar](https://github.com/djensenius/Telephone-Booth-Busy-Bar)
companion service. It is not part of the Operator API image or Compose stack.
Run exactly one monitor instance on an always-on home server, Portainer host, or
cloud container.

The companion consumes the authenticated Operator REST and WebSocket API, then
renders booth state, daily and active-installation counters, and system health
through BUSY Cloud. Its deployment guide, Portainer Compose file, environment
reference, and update steps live in the companion repository.

## Operator API contract

Create a static API token with the `monitor` scope in the operator UI. That
scope can access only:

- `GET /v1/status`
- `GET /v1/system/current`
- `GET /v1/monitor/summary`
- `/v1/ws/status`, limited to `status` and `system` envelopes

The summary endpoint returns aggregate counts for the active installation:

```json
{
  "interactionsToday": 12,
  "interactionsTotal": 143,
  "callsToday": 12,
  "messagesToday": 8,
  "callsTotal": 143,
  "messagesTotal": 96,
  "breakdownToday": {
    "noSelection": 3,
    "wrongNumberAttempts": 9,
    "messagesLeft": 5,
    "messagePlaybackStarts": 7,
    "instructionPlaybackStarts": 4
  },
  "dayStartedAt": "2026-08-08T04:00:00.000Z",
  "generatedAt": "2026-08-08T19:00:00.000Z",
  "timeZone": "America/Toronto"
}
```

`interactionsToday` counts pickups started on or after `dayStartedAt`, while
`interactionsTotal` counts all pickups in the active installation. The
deprecated `callsToday` and `callsTotal` fields remain as compatibility aliases
with identical values.

`breakdownToday` mixes the two intentional cohorts documented in
[analytics](analytics.md):

- `noSelection` and `messagesLeft` come from today's started pickups.
- `wrongNumberAttempts`, `messagePlaybackStarts`, and
  `instructionPlaybackStarts` come from today's booth events.

`messagesToday` counts messages completed on or after the same boundary, and
`messagesTotal` counts all completed messages in the active installation.
Messages still uploading are excluded because they do not yet have a
`receivedAt` timestamp.

`timeZone` is an optional IANA time-zone query parameter and defaults to
`America/Toronto`; it affects the daily boundary but not the installation
totals. The response never includes message identifiers, audio URLs,
transcripts, or moderation content.

The companion does not need an installation id in its configuration.
`GET /v1/status` and `GET /v1/monitor/summary` default to the active
installation, and live status updates are tagged by the API when the booth
reports them. `GET /v1/system/current` is deliberately not scoped: it describes
the current booth hardware and process health, which carries across an
installation rollover.

If the active installation has not received a booth status yet, the status
endpoint returns an id-less placeholder marked `isSynthetic: true`. Its
timestamp is deliberately non-fresh, and the companion continues treating it
as "no reported status" rather than a new idle heartbeat.

## Deployment order

1. Deploy this Operator release so `/v1/monitor/summary` is available.
2. Create or rotate a monitor-scoped token.
3. Deploy or update the companion service by following its README.
4. Stop and remove any former `busy-bar` service that runs the Operator API
   image with `node dist/busy-bar-worker.js`.

The companion needs no inbound ports or database access. A BUSY Cloud, device,
or companion outage does not affect Operator API health or booth traffic.
