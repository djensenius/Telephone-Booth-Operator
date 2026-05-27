import { useMemo } from "react";
import type { BoothSystemSnapshot, BoothThrottlingFlags } from "@telephone-booth-operator/shared";
import { GlassPanel, RuntimeModeBadge } from "../../components/booth/index.js";
import type { BoothRuntimeMode } from "../../components/booth/index.js";
import { useSystemCurrent } from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { fmtBytes, fmtNumber, fmtPercent, fmtUptime } from "./format.js";

const DEFAULT_BOOTH_ID = "booth-01";

// Map the Pi throttling flags struct to a human-readable summary. Only
// currently-asserted flags are included; "occurred" variants ride along so
// operators can spot transient brown-outs even after the booth recovers.
function summarizeThrottling(flags: BoothThrottlingFlags | null | undefined): string {
  if (!flags) return "—";
  const labels: string[] = [];
  if (flags.undervoltage) labels.push("under-voltage");
  if (flags.armFreqCapped) labels.push("arm-freq-capped");
  if (flags.throttled) labels.push("throttled");
  if (flags.softTempLimit) labels.push("soft-temp-limit");
  if (flags.undervoltageOccurred) labels.push("under-voltage-occurred");
  if (flags.throttledOccurred) labels.push("throttled-occurred");
  return labels.length > 0 ? labels.join(", ") : "none";
}

interface LiveSystemPanelProps {
  readonly boothId?: string;
}

export function LiveSystemPanel({ boothId = DEFAULT_BOOTH_ID }: LiveSystemPanelProps): JSX.Element {
  const query = useSystemCurrent(boothId);
  const snapshot = query.data?.snapshot as BoothSystemSnapshot | undefined;
  const receivedAt = query.data?.receivedAt;
  const clientVersion = query.data?.version ?? null;

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const cpu = snapshot.cpu;
    const memory = snapshot.memory;
    const audio = snapshot.audio;
    const tailscale = snapshot.tailscale;
    const memoryUsedBytes = memory?.usedBytes ?? null;
    const memoryTotalBytes = memory?.totalBytes ?? null;
    return [
      {
        label: "Phone client version",
        value: clientVersion ?? "—",
      },
      {
        label: "CPU temperature",
        value:
          snapshot.temperatureCelsius != null
            ? `${fmtNumber(snapshot.temperatureCelsius, 1)} °C`
            : "—",
      },
      {
        label: "CPU usage",
        value: cpu?.usageRatio != null ? `${(cpu.usageRatio * 100).toFixed(0)}%` : "—",
      },
      { label: "Load (1m)", value: fmtNumber(cpu?.loadAvg1m) },
      { label: "Load (5m)", value: fmtNumber(cpu?.loadAvg5m) },
      { label: "Load (15m)", value: fmtNumber(cpu?.loadAvg15m) },
      {
        label: "Memory",
        value: `${fmtBytes(memoryUsedBytes)} / ${fmtBytes(memoryTotalBytes)} (${fmtPercent(memoryUsedBytes, memoryTotalBytes)})`,
      },
      { label: "Uptime", value: fmtUptime(snapshot.uptimeSeconds) },
      { label: "Audio input device", value: audio?.inputDevice ?? "—" },
      { label: "Audio output device", value: audio?.outputDevice ?? "—" },
      {
        label: "Audio sample rate",
        value: typeof audio?.sampleRateHz === "number" ? `${audio.sampleRateHz} Hz` : "—",
      },
      {
        label: "Tailscale",
        value:
          tailscale?.connected == null
            ? "—"
            : tailscale.connected
              ? `up${tailscale.hostname ? ` (${tailscale.hostname})` : ""}`
              : "down",
      },
      {
        label: "Throttling",
        value: summarizeThrottling(snapshot.throttling),
      },
    ];
  }, [snapshot, clientVersion]);

  return (
    <GlassPanel title="Live system" className="feature-screen live-system-panel">
      <header className="live-system-panel__header">
        <div className="live-system-panel__heading">
          <h2>Live system</h2>
          <RuntimeModeBadge
            mode={(snapshot?.runtimeMode ?? null) as BoothRuntimeMode | null}
            className="live-system-panel__mode"
          />
        </div>
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
                    <li key={disk.mountPoint}>
                      <code>{disk.mountPoint}</code>
                      {disk.filesystem ? ` (${disk.filesystem})` : ""} —{" "}
                      {fmtBytes(disk.totalBytes - disk.availableBytes)} used of{" "}
                      {fmtBytes(disk.totalBytes)} (
                      {fmtPercent(disk.totalBytes - disk.availableBytes, disk.totalBytes)})
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {snapshot.networks?.length ? (
            <div className="live-system-panel__row live-system-panel__row--wide">
              <dt>Network</dt>
              <dd>
                <ul>
                  {snapshot.networks.map((iface) => (
                    <li key={iface.interface}>
                      <code>{iface.interface}</code> — rx {fmtBytes(iface.receiveBytesTotal)} · tx{" "}
                      {fmtBytes(iface.transmitBytesTotal)}
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
