import type { DisplayDrawParams, TextElement } from "@busy-app/busy-lib";
import {
  SYSTEM_HEALTH_THRESHOLDS,
  activeThrottlingLabels,
  aggregateSystemHealthSeverity,
} from "@telephone-booth-operator/shared";
import type {
  BoothState,
  BoothStatus,
  BoothSystemSnapshotEnvelope,
  SystemHealthSeverity,
} from "@telephone-booth-operator/shared";
import type { BusyBarMonitorConfig } from "./config.js";

export type FrontFrame = "state" | "health";
export type BackPage = 0 | 1 | 2;

export interface BusyBarMonitorState {
  status: BoothStatus | null;
  statusReceivedAtMs: number | null;
  system: BoothSystemSnapshotEnvelope | null;
  frontFrame: FrontFrame;
  backPage: BackPage;
  cloudConnected: boolean;
}

export interface BusyBarRender {
  payload: DisplayDrawParams;
  frontSignature: string;
  backSignature: string;
  signature: string;
  alertKind: "error" | "offline" | null;
}

const COLORS = {
  blue: "#005EBFFF",
  amber: "#FAAB00FF",
  cyan: "#00C8FFFF",
  red: "#FB2C36FF",
  violet: "#A855F7FF",
  green: "#00C16AFF",
  white: "#FFFFFFFF",
} as const;

const sanitize = (input: string, maximum: number): string =>
  input
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);

const statePresentation = (
  state: BoothState,
): { label: string; color: string; indicator?: string } => {
  if (state === "idle") return { label: "READY", color: COLORS.blue };
  if (state === "dialTone" || state === "dialing") return { label: "CALLING", color: COLORS.amber };
  if (state === "playingQuestion" || state === "playingMessage" || state === "playingInstructions")
    return { label: "PLAYING", color: COLORS.cyan };
  if (state === "beep" || state === "recording") return { label: "RECORDING", color: COLORS.red };
  if (state === "uploading") return { label: "SENDING", color: COLORS.violet };
  if (state === "callUnavailable")
    return { label: "UNAVAILABLE", color: COLORS.amber, indicator: COLORS.amber };
  return { label: "ERROR", color: COLORS.red, indicator: COLORS.red };
};

const ageMs = (timestamp: string | undefined, nowMs: number): number =>
  timestamp && Number.isFinite(new Date(timestamp).getTime())
    ? Math.max(0, nowMs - new Date(timestamp).getTime())
    : Number.POSITIVE_INFINITY;

export const statusIsStale = (
  statusReceivedAtMs: number | null,
  nowMs: number,
  staleAfterMs: number,
): boolean => statusReceivedAtMs === null || Math.max(0, nowMs - statusReceivedAtMs) > staleAfterMs;

const healthPresentation = (
  state: BusyBarMonitorState,
  nowMs: number,
  staleAfterMs: number,
): { label: string; color: string; severity: SystemHealthSeverity } => {
  if (
    !state.system ||
    ageMs(state.system.receivedAt, nowMs) > staleAfterMs ||
    !state.cloudConnected
  ) {
    return { label: "OFFLINE", color: COLORS.red, severity: "crit" };
  }
  const snapshot = state.system.snapshot;
  const throttling = activeThrottlingLabels(snapshot.throttling);
  if (
    snapshot.temperatureCelsius != null &&
    snapshot.temperatureCelsius >= SYSTEM_HEALTH_THRESHOLDS.temperatureCriticalCelsius
  ) {
    return { label: "HOT", color: COLORS.red, severity: "crit" };
  }
  if (throttling.length > 0) {
    return { label: "THROTTLED", color: COLORS.amber, severity: "warn" };
  }
  const severity = aggregateSystemHealthSeverity(snapshot);
  if (severity === "crit") return { label: "SYSTEM CRIT", color: COLORS.red, severity };
  if (severity === "warn") return { label: "SYSTEM WARN", color: COLORS.amber, severity };
  return { label: "SYSTEM OK", color: COLORS.green, severity };
};

const text = (
  id: string,
  display: "front" | "back",
  value: string,
  y: number,
  font: TextElement["font"],
  color: string = COLORS.white,
): TextElement => ({
  id,
  type: "text",
  x: display === "front" ? 36 : 2,
  y,
  display,
  align: display === "front" ? "center" : "top_left",
  text: sanitize(value, display === "front" ? 18 : 36),
  font,
  color,
  width: display === "front" ? 72 : 156,
});

const shortId = (value: string | null | undefined): string => (value ? value.slice(0, 8) : "--");

const percent = (used: number | null | undefined, total: number | null | undefined): string =>
  typeof used === "number" && typeof total === "number" && total > 0
    ? `${Math.round((used / total) * 100)}%`
    : "--";

const backLines = (state: BusyBarMonitorState, nowMs: number): string[] => {
  const status = state.status;
  const system = state.system;
  const snapshot = system?.snapshot;
  if (state.backPage === 0) {
    return [
      "CALL",
      `STATE ${status?.state ?? "--"}`,
      `AGE ${status ? Math.round(ageMs(status.updatedAt, nowMs) / 1000) : "--"}s`,
      `MODE ${status?.runtimeMode ?? snapshot?.runtimeMode ?? "--"}`,
      `QUESTION ${shortId(status?.currentQuestionId)}`,
      `MESSAGE ${shortId(status?.currentMessageId)}`,
      `ERROR ${status?.lastError ?? "CLEAR"}`,
    ];
  }
  if (state.backPage === 1) {
    const memory = snapshot?.memory;
    const disk = snapshot?.disks?.[0];
    return [
      "SYSTEM",
      `CLIENT ${system?.version ?? "--"}`,
      `TEMP ${snapshot?.temperatureCelsius?.toFixed(1) ?? "--"} C`,
      `CPU ${snapshot?.cpu?.usageRatio != null ? `${Math.round(snapshot.cpu.usageRatio * 100)}%` : "--"}`,
      `MEM ${percent(memory?.usedBytes, memory?.totalBytes)}`,
      `DISK ${disk ? percent(disk.totalBytes - disk.availableBytes, disk.totalBytes) : "--"}`,
      `UP ${snapshot?.uptimeSeconds != null ? `${Math.floor(snapshot.uptimeSeconds / 60)}m` : "--"}`,
    ];
  }
  const network = snapshot?.networks?.[0];
  return [
    "NETWORK",
    `TAILSCALE ${snapshot?.tailscale?.connected == null ? "--" : snapshot.tailscale.connected ? "UP" : "DOWN"}`,
    `HOST ${snapshot?.tailscale?.hostname ?? "--"}`,
    `PEERS ${snapshot?.tailscale?.peerCount ?? "--"}`,
    `IFACE ${network?.interface ?? "--"}`,
    `TELEM ${system ? Math.round(ageMs(system.receivedAt, nowMs) / 1000) : "--"}s`,
    `BUSY CLOUD ${state.cloudConnected ? "UP" : "DOWN"}`,
  ];
};

export const renderBusyBar = (
  state: BusyBarMonitorState,
  config: Extract<BusyBarMonitorConfig, { enabled: true }>,
  nowMs: number,
): BusyBarRender => {
  const offline = statusIsStale(state.statusReceivedAtMs, nowMs, config.staleAfterMs);
  const stateView = statePresentation(state.status?.state ?? "error");
  const healthView = healthPresentation(state, nowMs, config.staleAfterMs);
  const useHealth =
    offline ||
    (state.status?.state === "idle" &&
      (state.frontFrame === "health" || healthView.severity !== "ok"));
  const frontView = offline
    ? { label: "OFFLINE", color: COLORS.red, indicator: COLORS.red }
    : useHealth
      ? {
          label: healthView.label,
          color: healthView.color,
          indicator: healthView.severity === "ok" ? undefined : healthView.color,
        }
      : stateView;
  const frontElements = [
    text("front-label", "front", frontView.label, 8, "large", frontView.color),
  ];
  const lines = backLines(state, nowMs);
  const backElements = Array.from({ length: 7 }, (_, index) =>
    text(
      `back-line-${index}`,
      "back",
      lines[index] ?? "",
      index === 0 ? 1 : 12 + (index - 1) * 11,
      index === 0 ? "bold" : "small",
    ),
  );
  const frontSignature = JSON.stringify({
    indicator: frontView.indicator ?? null,
    elements: frontElements,
  });
  const backSignature = JSON.stringify(backElements);
  const payload: DisplayDrawParams = {
    application_name: config.applicationName,
    priority: config.displayPriority,
    ...(frontView.indicator ? { led_notification_color: frontView.indicator } : {}),
    elements: [...frontElements, ...backElements],
  };
  return {
    payload,
    frontSignature,
    backSignature,
    signature: JSON.stringify(payload),
    alertKind:
      offline || healthView.label === "OFFLINE"
        ? "offline"
        : state.status?.state === "error"
          ? "error"
          : null,
  };
};
