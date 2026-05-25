import { useMemo } from "react";
import type { BoothSystemSnapshot } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useSystemCurrent } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";

const DEFAULT_BOOTH_ID = "booth-01";

function fmtPercent(used: number | null | undefined, total: number | null | undefined): string {
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) return "—";
  return `${((used / total) * 100).toFixed(1)}%`;
}

function fmtBytes(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number") return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const mins = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function fmtNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

interface LiveSystemPanelProps {
  readonly boothId?: string;
}

export function LiveSystemPanel({ boothId = DEFAULT_BOOTH_ID }: LiveSystemPanelProps): JSX.Element {
  const query = useSystemCurrent(boothId);
  const snapshot = query.data?.snapshot as BoothSystemSnapshot | undefined;
  const receivedAt = query.data?.receivedAt;

  const rows = useMemo(() => {
    if (!snapshot) return [];
    return [
      {
        label: "CPU temperature",
        value:
          snapshot.cpuTemperatureCelsius != null
            ? `${fmtNumber(snapshot.cpuTemperatureCelsius, 1)} °C`
            : "—",
      },
      {
        label: "CPU usage",
        value:
          snapshot.cpuUsageRatio != null ? `${(snapshot.cpuUsageRatio * 100).toFixed(0)}%` : "—",
      },
      { label: "Load (1m)", value: fmtNumber(snapshot.loadAverage1m) },
      { label: "Load (5m)", value: fmtNumber(snapshot.loadAverage5m) },
      { label: "Load (15m)", value: fmtNumber(snapshot.loadAverage15m) },
      {
        label: "Memory",
        value: `${fmtBytes(snapshot.memoryUsedBytes)} / ${fmtBytes(snapshot.memoryTotalBytes)} (${fmtPercent(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes)})`,
      },
      { label: "Uptime", value: fmtUptime(snapshot.uptimeSeconds) },
      { label: "Hostname", value: snapshot.hostname ?? "—" },
      { label: "OS", value: snapshot.osVersion ?? "—" },
      { label: "Kernel", value: snapshot.kernelVersion ?? "—" },
      { label: "Audio input device", value: snapshot.audioInputDevice ?? "—" },
      { label: "Audio output device", value: snapshot.audioOutputDevice ?? "—" },
      { label: "Audio input dBFS", value: fmtNumber(snapshot.audioInputDbfs, 1) },
      { label: "Audio output dBFS", value: fmtNumber(snapshot.audioOutputDbfs, 1) },
      {
        label: "Tailscale",
        value:
          snapshot.tailscaleConnected == null
            ? "—"
            : snapshot.tailscaleConnected
              ? `up${snapshot.tailscaleHostname ? ` (${snapshot.tailscaleHostname})` : ""}`
              : "down",
      },
      {
        label: "Throttling",
        value: snapshot.throttlingFlags?.length ? snapshot.throttlingFlags.join(", ") : "none",
      },
    ];
  }, [snapshot]);

  return (
    <GlassPanel title="Live system" className="feature-screen live-system-panel">
      <header className="live-system-panel__header">
        <h2>Live system</h2>
        <p className="live-system-panel__subtitle">
          {receivedAt
            ? `Updated ${new Date(receivedAt).toLocaleTimeString()}`
            : query.isLoading
              ? "Connecting…"
              : "Awaiting first snapshot"}
        </p>
      </header>
      {query.isLoading && !snapshot ? <FeatureSkeleton label="Reading the meters…" /> : null}
      {query.error ? <FeatureError message="Could not read the booth's vitals." /> : null}
      {!query.isLoading && !query.error && !snapshot ? (
        <FeatureEmpty title="No snapshot yet">
          The booth has not pushed a system snapshot since the operator restarted. Snapshots arrive
          every five seconds when the booth is online.
        </FeatureEmpty>
      ) : null}
      {snapshot ? (
        <dl className="live-system-panel__grid">
          {rows.map((row) => (
            <div key={row.label} className="live-system-panel__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
          {snapshot.disks?.length ? (
            <div className="live-system-panel__row live-system-panel__row--wide">
              <dt>Disks</dt>
              <dd>
                <ul>
                  {snapshot.disks.map((disk) => (
                    <li key={disk.mountpoint}>
                      <code>{disk.mountpoint}</code> —{" "}
                      {fmtBytes(disk.totalBytes - disk.availableBytes)} used of{" "}
                      {fmtBytes(disk.totalBytes)} (
                      {fmtPercent(disk.totalBytes - disk.availableBytes, disk.totalBytes)})
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {snapshot.networkInterfaces?.length ? (
            <div className="live-system-panel__row live-system-panel__row--wide">
              <dt>Network</dt>
              <dd>
                <ul>
                  {snapshot.networkInterfaces.map((iface) => (
                    <li key={iface.name}>
                      <code>{iface.name}</code> — rx {fmtBytes(iface.receivedBytes)} · tx{" "}
                      {fmtBytes(iface.transmittedBytes)}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </GlassPanel>
  );
}
