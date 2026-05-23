import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel } from "../../components/booth/index.js";
import { createDebugClient, readDebugConnectionPrefs } from "../../lib/debug-client.js";
import type { AudioMeter, BoothStatus, DebugClient, DebugConnectionChange, GpioSnapshot, JsonValue, LogEntry, RedactedConfig, TelemetryRecord } from "../../lib/debug-client.js";
import { AudioPanel } from "./AudioPanel.js";
import { CertFingerprintCard } from "./CertFingerprintCard.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { ConnectionStatusBar } from "./ConnectionStatusBar.js";
import { GpioPanel } from "./GpioPanel.js";
import type { PulseAccumulator } from "./GpioPanel.js";
import { LogsPanel } from "./LogsPanel.js";
import { SimulatePanel } from "./SimulatePanel.js";
import { StateMachinePanel, transitionFromRecord } from "./StateMachinePanel.js";
import type { StateTransitionRow } from "./StateMachinePanel.js";

const INITIAL_CONNECTION: DebugConnectionChange = {
  transport: "disconnected",
  latencyMs: null,
  wsState: "idle",
};

function dbfsFromLinear(value: number): number {
  return Math.max(-120, 20 * Math.log10(Math.max(value, 0.000001)));
}

function upsertGpioEdge(snapshot: GpioSnapshot | undefined, record: Extract<TelemetryRecord, { readonly kind: "gpio_edge" }>): GpioSnapshot {
  const pins = [...(snapshot?.pins ?? [])];
  const index = pins.findIndex((pin) => pin.role === record.role);
  const pin = {
    role: record.role,
    level: record.level,
    debouncedState: record.level,
    lastEdgeMonotonicNs: record.at_monotonic_ns,
    lastEventId: record.id,
  };
  if (index === -1) {
    pins.push(pin);
  } else {
    pins[index] = pin;
  }
  return { pins, updatedAt: record.ts };
}

function applyAudioEvent(audio: AudioMeter | undefined, record: TelemetryRecord): AudioMeter | undefined {
  if (record.kind === "audio_level") {
    const next = audio ?? {
      inputLevelDbfs: -120,
      outputLevelDbfs: -120,
      inputPeakDbfs: -120,
      outputPeakDbfs: -120,
      currentDevice: null,
      sampleRateHz: null,
      updatedAt: null,
    };
    if (record.channel === "input") {
      return { ...next, inputLevelDbfs: dbfsFromLinear(record.rms), inputPeakDbfs: dbfsFromLinear(record.peak), updatedAt: record.ts };
    }
    return { ...next, outputLevelDbfs: dbfsFromLinear(record.rms), outputPeakDbfs: dbfsFromLinear(record.peak), updatedAt: record.ts };
  }
  if (record.kind === "audio_device_change") {
    return { ...(audio ?? { inputLevelDbfs: -120, outputLevelDbfs: -120, inputPeakDbfs: -120, outputPeakDbfs: -120, sampleRateHz: null, updatedAt: null }), currentDevice: record.name };
  }
  return audio;
}

function updateStatus(status: BoothStatus | undefined, transition: StateTransitionRow): BoothStatus {
  return {
    state: transition.to,
    updatedAt: transition.ts,
    currentQuestionId: status?.currentQuestionId ?? null,
    currentMessageId: status?.currentMessageId ?? null,
    lastError: status?.lastError ?? null,
  };
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findPinLabel(value: JsonValue | undefined, role: string): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly JsonValue[]) {
      const found = findPinLabel(item, role);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }
  const roleNeedle = role.replaceAll("_", "").toLowerCase();
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").toLowerCase();
    if (normalizedKey.includes(roleNeedle)) {
      if (typeof child === "number") {
        return `Pin ${child}`;
      }
      if (isObject(child)) {
        for (const pinKey of ["bcm", "bcmPin", "pin", "pinNumber"] as const) {
          const pin = child[pinKey];
          if (typeof pin === "number") {
            return `Pin ${pin}`;
          }
        }
      }
    }
    const found = findPinLabel(child, role);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function buildPinLabels(config: RedactedConfig | undefined): ReadonlyMap<string, string> {
  const gpio = config?.gpio;
  return new Map(
    ["hook", "rotary_pulse", "rotary_read"].flatMap((role) => {
      const label = findPinLabel(gpio, role);
      return label === undefined ? [] : [[role, label] as const];
    }),
  );
}

function allowControls(config: RedactedConfig | undefined): boolean {
  return config?.debug?.allowControls === true;
}

export function DebugScreen(): JSX.Element {
  const [prefs] = useState(() => readDebugConnectionPrefs());
  const hasPrefs = prefs.tailscaleUrl.length > 0 || prefs.lanUrl.length > 0;
  const [connection, setConnection] = useState<DebugConnectionChange>(INITIAL_CONNECTION);
  const [level, setLevel] = useState("info");
  const [liveStatus, setLiveStatus] = useState<BoothStatus | undefined>();
  const [liveGpio, setLiveGpio] = useState<GpioSnapshot | undefined>();
  const [liveAudio, setLiveAudio] = useState<AudioMeter | undefined>();
  const [liveLogs, setLiveLogs] = useState<readonly LogEntry[]>([]);
  const [transitions, setTransitions] = useState<readonly StateTransitionRow[]>([]);
  const [pulseAccumulator, setPulseAccumulator] = useState<PulseAccumulator>({ currentCount: 0, lastDigit: null, lastPulseCount: null });

  const client = useMemo<DebugClient | null>(() => {
    if (!hasPrefs) {
      return null;
    }
    return createDebugClient({
      tailscaleUrl: prefs.tailscaleUrl,
      lanUrl: prefs.lanUrl,
      token: prefs.token,
      pinnedFingerprint: prefs.pinnedFingerprint,
      onConnectionChanged: setConnection,
    });
  }, [hasPrefs, prefs.lanUrl, prefs.pinnedFingerprint, prefs.tailscaleUrl, prefs.token]);

  const wsConnected = connection.wsState === "open";
  const stateQuery = useQuery({ queryKey: ["debug", "state"], queryFn: () => client!.getState(), enabled: client !== null, refetchInterval: wsConnected ? false : 2_000 });
  const gpioQuery = useQuery({ queryKey: ["debug", "gpio"], queryFn: () => client!.getGpio(), enabled: client !== null, refetchInterval: wsConnected ? false : 2_000 });
  const audioQuery = useQuery({ queryKey: ["debug", "audio"], queryFn: () => client!.getAudio(), enabled: client !== null, refetchInterval: wsConnected ? false : 2_000 });
  const logsQuery = useQuery({ queryKey: ["debug", "logs", level], queryFn: () => client!.getLogs({ level, limit: 200 }), enabled: client !== null, refetchInterval: wsConnected ? false : 2_000 });
  const configQuery = useQuery({ queryKey: ["debug", "config"], queryFn: () => client!.getConfig(), enabled: client !== null, staleTime: 30_000 });
  const eventsQuery = useQuery({ queryKey: ["debug", "events"], queryFn: () => client!.getEvents(), enabled: client !== null, staleTime: 10_000 });

  useEffect(() => setLiveStatus(stateQuery.data), [stateQuery.data]);
  useEffect(() => setLiveGpio(gpioQuery.data), [gpioQuery.data]);
  useEffect(() => setLiveAudio(audioQuery.data), [audioQuery.data]);
  useEffect(() => setLiveLogs(logsQuery.data ?? []), [logsQuery.data]);
  useEffect(() => {
    const rows = (eventsQuery.data ?? []).map(transitionFromRecord).filter((row): row is StateTransitionRow => row !== null).slice(-50).reverse();
    if (rows.length > 0) {
      setTransitions(rows);
    }
  }, [eventsQuery.data]);

  useEffect(() => {
    if (client === null) {
      return undefined;
    }
    return client.subscribe((record) => {
      if (record.kind === "gpio_edge") {
        setLiveGpio((current) => upsertGpioEdge(current, record));
        if (record.role === "rotary_pulse" && record.level) {
          setPulseAccumulator((current) => ({ ...current, currentCount: current.currentCount + 1 }));
        }
      }
      const transition = transitionFromRecord(record);
      if (transition !== null) {
        setTransitions((current) => [transition, ...current].slice(0, 50));
        setLiveStatus((current) => updateStatus(current, transition));
      }
      if (record.kind === "digit_dialed") {
        setPulseAccumulator({ currentCount: 0, lastDigit: record.digit, lastPulseCount: record.pulses });
      }
      if (record.kind === "audio_level" || record.kind === "audio_device_change") {
        setLiveAudio((current) => applyAudioEvent(current, record));
      }
      if (record.kind === "log") {
        setLiveLogs((current) => [...current, { ts: record.ts, level: record.level, target: record.target, message: record.message }].slice(-200));
      }
      if (record.kind === "error") {
        setLiveLogs((current) => [...current, { ts: record.ts, level: "error", target: record.source, message: record.message }].slice(-200));
      }
    });
  }, [client]);

  const config = configQuery.data;
  const pinLabels = useMemo(() => buildPinLabels(config), [config]);

  return (
    <GlassPanel title="Phone-booth debug surface" className="debug-screen">
      <p className="screen-kicker">Digit 9</p>
      <h1>Debug</h1>
      <p>Operator diagnostics for the phone client. Tailscale is tried first; LAN is the pinned-certificate fallback.</p>
      <ConnectionStatusBar connection={connection} hasPrefs={hasPrefs} />
      {!hasPrefs ? <p className="debug-callout">Configure the Phone Client Connection panel in Settings to open this line.</p> : null}
      <div className="debug-grid">
        <StateMachinePanel status={liveStatus} transitions={transitions} />
        <GpioPanel snapshot={liveGpio} pulseAccumulator={pulseAccumulator} pinLabels={pinLabels} />
        <AudioPanel audio={liveAudio} status={liveStatus} />
        <LogsPanel logs={liveLogs} level={level} onLevelChange={setLevel} />
        <ConfigPanel config={config} />
        <CertFingerprintCard fingerprint={prefs.pinnedFingerprint} />
        <SimulatePanel allowControls={allowControls(config)} client={client} />
      </div>
    </GlassPanel>
  );
}
