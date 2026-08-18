import type { JSX } from "react";
// Compact, always-visible vitals strip for the operator sidebar. Pi-Hole
// shows host vitals on every page; this is the same idea — once an operator
// is signed in, we want them to see the booth's CPU temperature, load, and
// memory at a glance without having to navigate to the dedicated `/system`
// route.
//
// Data flow: host values read from the same `["system", boothId]` react-query
// cache that the full `LiveSystemPanel` and status WebSocket populate. Router
// battery temperature comes from the component-current query. Both refresh at
// a five-second cadence on authenticated pages.

import {
  SYSTEM_HEALTH_THRESHOLDS,
  activeThrottlingLabels,
  aggregateSystemHealthSeverity,
  systemLoadSeverity,
  systemMemorySeverity,
  systemTemperatureSeverity,
} from "@telephone-booth-operator/shared";
import type { SystemHealthSeverity } from "@telephone-booth-operator/shared";
import { useComponentTelemetryCurrent, useSystemCurrent } from "../../lib/api-client.js";
import { FanVitalTile } from "./FanVitalTile.js";
import { fmtBytes, fmtNumber, fmtPercent, fmtUptime } from "./format.js";

const DEFAULT_BOOTH_ID = "booth-01";

interface SystemVitalsStripProps {
  readonly boothId?: string;
}

interface TileProps {
  readonly label: string;
  readonly value: string;
  readonly severity?: SystemHealthSeverity;
  readonly hint?: string;
}

function VitalTile({ label, value, severity = "ok", hint }: TileProps): JSX.Element {
  return (
    <div
      className={`system-vitals-strip__tile system-vitals-strip__tile--${severity}`}
      title={hint ?? label}
    >
      <span className="system-vitals-strip__tile-label">{label}</span>
      <span className="system-vitals-strip__tile-value">{value}</span>
    </div>
  );
}

export function SystemVitalsStrip({
  boothId = DEFAULT_BOOTH_ID,
}: SystemVitalsStripProps): JSX.Element {
  const query = useSystemCurrent(boothId);
  const componentQuery = useComponentTelemetryCurrent({ boothId });
  const snapshot = query.data?.snapshot;
  const receivedAt = query.data?.receivedAt;
  const componentSources = componentQuery.data ?? [];
  const routerSource =
    componentSources.find((source) => source.componentId === "router") ?? componentSources[0];
  const routerBatteryTemperature = routerSource?.latestSnapshot?.battery?.temperatureCelsius;

  // Pull commonly-used nested fields up so the JSX below stays readable. The
  // canonical wire format groups CPU/memory/etc into sub-objects (mirroring
  // the Rust `booth-hal::SystemSnapshot` struct), so every read goes through
  // optional chaining.
  const cpu = snapshot?.cpu;
  const memory = snapshot?.memory;
  const tailscale = snapshot?.tailscale;
  const throttling = snapshot?.throttling;
  const temperatureCelsius = snapshot?.temperatureCelsius;
  const memoryUsedBytes = memory?.usedBytes ?? null;
  const memoryTotalBytes = memory?.totalBytes ?? null;
  const cpuUsageRatio = cpu?.usageRatio ?? null;
  const loadAvg1m = cpu?.loadAvg1m ?? null;
  // Prefer the explicit `physicalCores` field, but fall back to the length of
  // the per-core usage array if the adapter only filled in one or the other.
  const cpuCores =
    typeof cpu?.physicalCores === "number" && cpu.physicalCores > 0
      ? cpu.physicalCores
      : Array.isArray(cpu?.perCoreUsageRatio) && cpu.perCoreUsageRatio.length > 0
        ? cpu.perCoreUsageRatio.length
        : null;
  // Collect any throttling flags that are currently asserted so the tile can
  // show a count + tooltip without leaking the Pi-specific field names into
  // the UI.
  const activeThrottlingFlags = activeThrottlingLabels(throttling);

  // Show a placeholder strip when there's nothing cached yet so the layout
  // doesn't pop in once the first refetch resolves.
  const isEmpty = !snapshot;
  const status: string = receivedAt
    ? `Updated ${new Date(receivedAt).toLocaleTimeString()}`
    : query.isLoading
      ? "Connecting…"
      : query.error
        ? "Booth offline"
        : "Awaiting first snapshot";

  // Severity announcement for assistive technology. We deliberately do NOT
  // place `aria-live` on the tile grid itself, because the strip re-renders
  // every 5 s — broadcasting every numeric tick to screen-reader users would
  // be relentless. Instead we summarise the highest tile severity in a
  // visually-hidden live region so SR users only hear "warning" / "critical"
  // when the booth's health changes, not on every refetch.
  const tempSev = systemTemperatureSeverity(temperatureCelsius);
  const memSev = systemMemorySeverity(memoryUsedBytes, memoryTotalBytes);
  const loadSev = systemLoadSeverity(loadAvg1m, cpuCores);
  const aggregateSeverity = aggregateSystemHealthSeverity(snapshot);
  const liveSummary = isEmpty
    ? ""
    : aggregateSeverity === "crit"
      ? "Booth vitals critical"
      : aggregateSeverity === "warn"
        ? "Booth vitals warning"
        : "Booth vitals nominal";

  return (
    <section className="system-vitals-strip" aria-label="Live booth vitals">
      <header className="system-vitals-strip__header">
        <h2>Live vitals</h2>
        <a className="system-vitals-strip__link" href="/system">
          Details →
        </a>
      </header>
      <span className="sr-only" aria-live="polite">
        {liveSummary}
      </span>
      <div className="system-vitals-strip__tiles">
        <VitalTile
          label="CPU temp"
          value={
            typeof temperatureCelsius === "number" ? `${fmtNumber(temperatureCelsius, 1)}°C` : "—"
          }
          severity={tempSev}
          hint={`CPU temperature (warn ≥${SYSTEM_HEALTH_THRESHOLDS.temperatureWarnCelsius}°C, crit ≥${SYSTEM_HEALTH_THRESHOLDS.temperatureCriticalCelsius}°C)`}
        />
        <VitalTile
          label="Router battery"
          value={
            typeof routerBatteryTemperature === "number"
              ? `${fmtNumber(routerBatteryTemperature, 1)}°C`
              : componentQuery.isLoading
                ? "…"
                : componentQuery.error
                  ? "offline"
                  : "—"
          }
          hint={
            typeof routerBatteryTemperature === "number"
              ? `${routerSource?.displayName ?? "Router"} battery temperature`
              : componentQuery.isLoading
                ? "Connecting to router telemetry"
                : componentQuery.error
                  ? "Router telemetry is unavailable"
                  : "Router battery temperature has not been reported"
          }
        />
        <VitalTile
          label="CPU"
          value={typeof cpuUsageRatio === "number" ? `${(cpuUsageRatio * 100).toFixed(0)}%` : "—"}
          hint="Average CPU usage across all cores"
        />
        <VitalTile
          label="Load 1m"
          value={fmtNumber(loadAvg1m)}
          severity={loadSev}
          hint={cpuCores ? `1-minute load average (${cpuCores} cores)` : "1-minute load average"}
        />
        <VitalTile
          label="Memory"
          value={fmtPercent(memoryUsedBytes, memoryTotalBytes)}
          severity={memSev}
          hint={
            memoryUsedBytes != null && memoryTotalBytes != null
              ? `${fmtBytes(memoryUsedBytes)} of ${fmtBytes(memoryTotalBytes)} in use`
              : "Memory utilisation"
          }
        />
        <VitalTile
          label="Uptime"
          value={fmtUptime(snapshot?.uptimeSeconds)}
          hint="Host uptime since last boot"
        />
        <FanVitalTile fan={snapshot?.fan} />
        {activeThrottlingFlags.length > 0 ? (
          <VitalTile
            label="Throttling"
            value={`${activeThrottlingFlags.length}`}
            severity="warn"
            hint={`Pi reports: ${activeThrottlingFlags.join(", ")}`}
          />
        ) : null}
        {tailscale?.connected === false ? (
          <VitalTile
            label="Tailscale"
            value="down"
            severity="crit"
            hint="Tailscale link is reporting disconnected"
          />
        ) : null}
      </div>
      <footer
        className={`system-vitals-strip__footer${isEmpty ? " system-vitals-strip__footer--muted" : ""}`}
      >
        {status}
      </footer>
    </section>
  );
}
