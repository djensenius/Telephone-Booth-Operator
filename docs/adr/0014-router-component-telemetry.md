# ADR 0014 — Router component telemetry through Grafana

**Status:** accepted.

## Context

The booth router exposes battery, charger, and thermal telemetry. Prometheus on
the private Tailscale server already owns the historical samples, while the
Operator deployment is intentionally outside the tailnet. Copying time-series
history into the Operator database would create two owners, duplicate
retention/downsampling concerns, and make the current-snapshot write path much
heavier.

Router credentials also need a narrower boundary than the existing booth,
worker, and monitor tokens. Accepting `boothId` and `componentId` on every write
would let a leaked component credential overwrite another component's current
state.

## Decision

Add a persistent `TelemetrySource` identified by `(boothId, componentId)`.
Telemetry-scoped API tokens must reference one source, and multiple tokens may
reference it so credentials can rotate without changing component identity.
`PUT /v1/system/components/current` derives identity only from that relation
and stores one latest JSON snapshot plus client/server timestamps in Postgres.

Historical samples stay in Prometheus. The backend queries them through a
public Grafana instance's authenticated datasource proxy using a server-side
service-account token and configured Prometheus datasource UID. Clients supply
only source identity, time range, and step. The API constructs one selector
from:

- a fixed router metric allowlist;
- the source's exact `job` label; and
- the source's exact `instance` label.

Arbitrary PromQL is not accepted. Queries are capped at 31 days, a minimum
15-second step, and 10,000 points per series. Missing Grafana configuration is
a `503`; failed or malformed upstream responses are a logged `502`.
Snapshot request bodies are capped at 64 KiB before JSON parsing. Grafana
responses are streamed into a bounded 4 MiB buffer and may contain at most 128
series and 100,000 samples total; exceeding any limit is also a logged `502`.

The battery snapshot keeps kernel `cycleCount` separate from the router MCU's
`chargeCount` (`charge_cnt`). MCU `chargingStatus` is preserved as an integer,
not coerced to a boolean or label. The MCU's `abnormal_type` is likewise
preserved as integer `abnormalType`.

This change is backend-only. It defines persistence and API contracts but does
not add web or mobile presentation.

## Consequences

- Postgres owns component identity and the latest snapshot, not historical
  samples.
- Prometheus remains the single historical source of truth and keeps its
  existing retention policy.
- Grafana is the public, authenticated bridge into the private datasource; the
  Operator API never needs tailnet membership.
- Service-account credentials remain server-side.
- Rotating a telemetry token preserves the source and current snapshot.
- Adding a historical metric requires an explicit backend allowlist and API
  contract change.
