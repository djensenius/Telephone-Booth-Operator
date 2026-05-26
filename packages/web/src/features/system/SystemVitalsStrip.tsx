// Compact, always-visible vitals strip for the operator sidebar. Pi-Hole
// shows host vitals on every page; this is the same idea — once an operator
// is signed in, we want them to see the booth's CPU temperature, load, and
// memory at a glance without having to navigate to the dedicated `/system`
// route.
//
// Data flow: read from the same `["system", boothId]` react-query cache
// that the full `LiveSystemPanel` and the status WebSocket already populate,
// so on the status screen the strip updates in real time and on every other
// authenticated page it refreshes at the polling cadence (5 s, matching the
// booth's `PUT /v1/system` interval).

import type { BoothSystemSnapshot } from "@telephone-booth-operator/shared";
import { useSystemCurrent } from "../../lib/api-client.js";
import { fmtBytes, fmtNumber, fmtPercent, fmtUptime } from "./format.js";

const DEFAULT_BOOTH_ID = "booth-01";

// Visual thresholds — chosen to match the Prometheus alerts shipped with
// the booth's Grafana dashboards.
const TEMP_WARN_C = 60;
const TEMP_CRIT_C = 75;
const MEMORY_WARN_RATIO = 0.85;
const MEMORY_CRIT_RATIO = 0.95;

type Severity = "ok" | "warn" | "crit";

function temperatureSeverity(value: number | null | undefined): Severity {
  if (typeof value !== "number") return "ok";
  if (value >= TEMP_CRIT_C) return "crit";
  if (value >= TEMP_WARN_C) return "warn";
  return "ok";
}

function memorySeverity(
  used: number | null | undefined,
  total: number | null | undefined,
): Severity {
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) return "ok";
  const ratio = used / total;
  if (ratio >= MEMORY_CRIT_RATIO) return "crit";
  if (ratio >= MEMORY_WARN_RATIO) return "warn";
  return "ok";
}

function loadSeverity(value: number | null | undefined, cores: number | null | undefined): Severity {
  if (typeof value !== "number") return "ok";
  // Treat one runnable task per core as the warning threshold; double that
  // as critical. Falls back to a sane single-core default if we don't know
  // the core count yet.
  const reference = typeof cores === "number" && cores > 0 ? cores : 1;
  if (value >= reference * 2) return "crit";
  if (value >= reference) return "warn";
  return "ok";
}

interface SystemVitalsStripProps {
  readonly boothId?: string;
}

interface TileProps {
  readonly label: string;
  readonly value: string;
  readonly severity?: Severity;
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
  const snapshot = query.data?.snapshot as BoothSystemSnapshot | undefined;
  const receivedAt = query.data?.receivedAt;

  const cpuCores =
    Array.isArray(snapshot?.cpuUsageRatioPerCore) && snapshot.cpuUsageRatioPerCore.length > 0
      ? snapshot.cpuUsageRatioPerCore.length
      : null;

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
  const tempSev = temperatureSeverity(snapshot?.cpuTemperatureCelsius);
  const memSev = memorySeverity(snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes);
  const loadSev = loadSeverity(snapshot?.loadAverage1m, cpuCores);
  const throttleSev: Severity = snapshot?.throttlingFlags?.length ? "warn" : "ok";
  const tailscaleSev: Severity = snapshot?.tailscaleConnected === false ? "crit" : "ok";
  const aggregateSeverity: Severity = (
    [tempSev, memSev, loadSev, throttleSev, tailscaleSev] as readonly Severity[]
  ).reduce<Severity>((acc, s) => (s === "crit" ? "crit" : s === "warn" && acc === "ok" ? "warn" : acc), "ok");
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
            typeof snapshot?.cpuTemperatureCelsius === "number"
              ? `${fmtNumber(snapshot.cpuTemperatureCelsius, 1)}°C`
              : "—"
          }
          severity={tempSev}
          hint={`CPU temperature (warn ≥${TEMP_WARN_C}°C, crit ≥${TEMP_CRIT_C}°C)`}
        />
        <VitalTile
          label="CPU"
          value={
            typeof snapshot?.cpuUsageRatio === "number"
              ? `${(snapshot.cpuUsageRatio * 100).toFixed(0)}%`
              : "—"
          }
          hint="Average CPU usage across all cores"
        />
        <VitalTile
          label="Load 1m"
          value={fmtNumber(snapshot?.loadAverage1m)}
          severity={loadSev}
          hint={
            cpuCores
              ? `1-minute load average (${cpuCores} cores)`
              : "1-minute load average"
          }
        />
        <VitalTile
          label="Memory"
          value={fmtPercent(snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes)}
          severity={memSev}
          hint={
            snapshot?.memoryUsedBytes != null && snapshot.memoryTotalBytes != null
              ? `${fmtBytes(snapshot.memoryUsedBytes)} of ${fmtBytes(snapshot.memoryTotalBytes)} in use`
              : "Memory utilisation"
          }
        />
        <VitalTile
          label="Uptime"
          value={fmtUptime(snapshot?.uptimeSeconds)}
          hint="Host uptime since last boot"
        />
        {snapshot?.throttlingFlags?.length ? (
          <VitalTile
            label="Throttling"
            value={`${snapshot.throttlingFlags.length}`}
            severity="warn"
            hint={`Pi reports: ${snapshot.throttlingFlags.join(", ")}`}
          />
        ) : null}
        {snapshot?.tailscaleConnected === false ? (
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
