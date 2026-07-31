# Observability (events + live system)

The operator API persists structured booth events and surfaces the booth's
live system vitals. Historical metrics (CPU temp, load, audio dBFS, etc.)
are scraped by `vmagent` running alongside the booth and stored in an
external VictoriaMetrics instance; Grafana dashboards live under
`dashboards/` in the booth repo.

## Data model

- **`BoothEvent`** — append-only event log. Idempotent on
  `(boothId, eventId)`. The booth generates `eventId =
"{bootId}:{telemetryRecordId}"` so retries are safe.
- **`CallSession`** — derived from `call_started` / `call_ended` events.
  Lazily upserted at insert time. Holds the dialed-digits string,
  call outcome, recording id, and duration.
- **`BoothSystemSnapshot`** — one current row per booth, upserted by live
  system pushes so reads stay consistent across API replicas. VictoriaMetrics
  remains the time-series owner.

## HTTP routes

| Route                    | Auth             | Notes                                    |
| ------------------------ | ---------------- | ---------------------------------------- |
| `POST /v1/events`        | API token        | Bulk insert (max 500), `skipDuplicates`. |
| `GET /v1/events`         | Operator cookie  | Cursor-paginated, filterable.            |
| `GET /v1/events/stream`  | Operator cookie  | SSE live tail. Same-origin only.         |
| `GET /v1/sessions`       | Operator cookie  | Cursor-paginated.                        |
| `GET /v1/sessions/:id`   | Operator cookie  | Session + ordered events.                |
| `PUT /v1/system`         | API token        | Upsert current row + WS broadcast.       |
| `GET /v1/system/current` | Cookie or bearer | Latest persisted snapshot.               |
| `GET /v1/ws/status`      | Cookie or bearer | Discriminated `{kind,…}` envelope.       |

Cursors are base64url-encoded `(receivedAt, id)` tuples and pair with the
composite `@@index([boothId, receivedAt, id])` for stable pagination.
Operator-cookie-only auth on the SSE endpoint exists because EventSource
cannot send a Bearer token.

## Clock and ordering

Every event carries both an `occurredAt` (booth wall clock) and a
server-stamped `receivedAt`. The list endpoint sorts by `receivedAt` so
clock skew across reboots can't reorder the log; UIs may resort by
`occurredAt` for display.

## Web UI

The operator console exposes the observability data on three dedicated
screens accessible from the **Observability** block in the sidebar:

- **Live system** (`/system`) — bar/lamp readouts for CPU, temperature,
  memory, disk, network, uptime, audio device, Tailscale link, and
  throttling flags. Updates in real time via the status WebSocket.
- **Events** (`/events`) — paginated, filterable table of booth events
  with links into the originating call session.
- **Sessions** (`/sessions`) — paginated list of call sessions; each row
  links to a detail page (`/sessions/:id`) showing the full ordered
  event timeline along with outcome, dialed digits, recording id, and
  duration.
- **Audit log** (`/audit`) — who took each write action, from which
  address, and when. Admin-only; see [Audit log](audit-log.md).

These screens are gated by the same operator OIDC session that guards
the rest of the console; the audit log additionally requires admin.

## BUSY Bar physical monitor

The optional singleton [BUSY Bar monitor](busy-bar-monitor.md) consumes live
status and system snapshots through the authenticated operator REST/WebSocket
API. It logs sanitized connection, render, retry, and input-stream state through
Pino. BUSY credentials and authentication payloads must never appear in logs.
Integration failures are intentionally excluded from API health because the bar
is an auxiliary display.
