import type { JSX } from "react";
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GlassPanel } from "../../components/booth/index.js";
import { useCurrentUser } from "../auth/useCurrentUser.js";
import { createDebugClient, readDebugConnectionPrefs } from "../../lib/debug-client.js";
import type {
  BoothStatus,
  DebugClient,
  DebugConnectionChange,
  GpioSnapshot,
  JsonValue,
  LogEntry,
  RedactedConfig,
  TelemetryRecord,
} from "../../lib/debug-client.js";
import { AudioPanel } from "./AudioPanel.js";
import type { AudioDeviceInfo } from "./AudioPanel.js";
import {
  changedPolledChannels,
  EMPTY_AUDIO_METERS,
  LIVE_SAMPLE_STALE_AFTER_MS,
  NO_POLLED_IDENTITIES,
  nextMeterUpdateDelay,
  polledIdentities,
  dbfsFromLinear,
  recordPolledSnapshot,
  mergeMeterStates,
  recordSample,
  resolveMeter,
} from "./audio-meters.js";
import type { AudioChannel, AudioMeterState, PolledMeterIdentities } from "./audio-meters.js";
import { CertFingerprintCard } from "./CertFingerprintCard.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { ConnectionStatusBar } from "./ConnectionStatusBar.js";
import { GpioPanel } from "./GpioPanel.js";
import type { PulseAccumulator } from "./GpioPanel.js";
import { LogsPanel } from "./LogsPanel.js";
import { SimulatePanel } from "./SimulatePanel.js";
import { StateMachinePanel, transitionFromRecord } from "./StateMachinePanel.js";
import type { StateTransitionRow } from "./StateMachinePanel.js";

interface PolledAudioObservation {
  readonly snapshot: Awaited<ReturnType<DebugClient["getAudio"]>>;
  readonly receivedAt: number;
  readonly identities: PolledMeterIdentities;
  readonly meters: AudioMeterState;
}

const INITIAL_CONNECTION: DebugConnectionChange = {
  transport: "disconnected",
  latencyMs: null,
  wsState: "idle",
};

function upsertGpioEdge(
  snapshot: GpioSnapshot | undefined,
  record: Extract<TelemetryRecord, { readonly kind: "gpio_edge" }>,
): GpioSnapshot {
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

function audioMetadata(
  audio: AudioDeviceInfo | undefined,
  record: TelemetryRecord,
): AudioDeviceInfo | undefined {
  const current = audio ?? { currentDevice: null, sampleRateHz: null, updatedAt: null };
  if (record.kind === "audio_level") {
    return { ...current, updatedAt: record.ts };
  }
  if (record.kind === "audio_device_change") {
    return { ...current, currentDevice: record.name };
  }
  return audio;
}

function updateStatus(
  status: BoothStatus | undefined,
  transition: StateTransitionRow,
): BoothStatus {
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
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  // Settings persists under the operator's subject, so read the same key here
  // rather than the "anonymous" default.
  const prefs = useMemo(() => readDebugConnectionPrefs(user?.id), [user?.id]);
  const hasPrefs = prefs.tailscaleUrl.length > 0 || prefs.lanUrl.length > 0;
  const [connection, setConnection] = useState<DebugConnectionChange>(INITIAL_CONNECTION);
  const [level, setLevel] = useState("info");
  const [liveStatus, setLiveStatus] = useState<BoothStatus | undefined>();
  const [observedStatus, setObservedStatus] = useState<BoothStatus | undefined>();
  const [liveGpio, setLiveGpio] = useState<GpioSnapshot | undefined>();
  const [observedGpio, setObservedGpio] = useState<GpioSnapshot | undefined>();
  const [liveAudio, setLiveAudio] = useState<AudioDeviceInfo | undefined>();
  const [observedAudio, setObservedAudio] = useState<PolledAudioObservation | undefined>();
  const [audioMeters, setAudioMeters] = useState<AudioMeterState>(EMPTY_AUDIO_METERS);
  const [meterNow, setMeterNow] = useState<number>(() => Date.now());
  const [liveLogs, setLiveLogs] = useState<readonly LogEntry[]>([]);
  const [observedLogs, setObservedLogs] = useState<readonly LogEntry[] | undefined>();
  const [transitions, setTransitions] = useState<readonly StateTransitionRow[]>([]);
  const [observedEvents, setObservedEvents] = useState<readonly TelemetryRecord[] | undefined>();
  const [pulseAccumulator, setPulseAccumulator] = useState<PulseAccumulator>({
    currentCount: 0,
    lastDigit: null,
    lastPulseCount: null,
  });

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
  const stateQuery = useQuery({
    queryKey: ["debug", "state"],
    queryFn: () => client!.getState(),
    enabled: client !== null,
    refetchInterval: wsConnected ? false : 2_000,
  });
  const gpioQuery = useQuery({
    queryKey: ["debug", "gpio"],
    queryFn: () => client!.getGpio(),
    enabled: client !== null,
    refetchInterval: wsConnected ? false : 2_000,
  });
  const audioQuery = useQuery({
    queryKey: ["debug", "audio"],
    queryFn: async () => {
      const snapshot = await client!.getAudio();
      // Cache the original per-channel receive dates, not a remount's time.
      // Query completions update the cache, never an old component instance.
      const receivedAt = Date.now();
      const previous = queryClient.getQueryData<PolledAudioObservation>(["debug", "audio"]);
      const identities = polledIdentities(snapshot);
      const changed = changedPolledChannels(
        previous?.identities ?? NO_POLLED_IDENTITIES,
        identities,
      );
      return {
        snapshot,
        receivedAt,
        identities,
        meters: recordPolledSnapshot(
          previous?.meters ?? EMPTY_AUDIO_METERS,
          snapshot,
          changed,
          receivedAt,
        ),
      } satisfies PolledAudioObservation;
    },
    enabled: client !== null,
    refetchInterval: wsConnected ? false : 2_000,
  });
  const logsQuery = useQuery({
    queryKey: ["debug", "logs", level],
    queryFn: () => client!.getLogs({ level, limit: 200 }),
    enabled: client !== null,
    refetchInterval: wsConnected ? false : 2_000,
  });
  const configQuery = useQuery({
    queryKey: ["debug", "config"],
    queryFn: () => client!.getConfig(),
    enabled: client !== null,
    staleTime: 30_000,
  });
  const eventsQuery = useQuery({
    queryKey: ["debug", "events"],
    queryFn: () => client!.getEvents(),
    enabled: client !== null,
    staleTime: 10_000,
  });

  // Follow the active query observer, not individual request completions.
  // This handles cached mounts and ignores late results for an old log filter,
  // while preserving WebSocket additions until the observed baseline changes.
  if (observedStatus !== stateQuery.data) {
    setObservedStatus(stateQuery.data);
    setLiveStatus(stateQuery.data);
  }
  if (observedGpio !== gpioQuery.data) {
    setObservedGpio(gpioQuery.data);
    setLiveGpio(gpioQuery.data);
  }
  if (observedAudio !== audioQuery.data) {
    setObservedAudio(audioQuery.data);
    setLiveAudio(audioQuery.data?.snapshot);
    if (audioQuery.data) {
      const { meters, receivedAt } = audioQuery.data;
      setMeterNow((current) => Math.max(current, receivedAt));
      setAudioMeters((current) => mergeMeterStates(current, meters));
    }
  }
  if (observedLogs !== logsQuery.data) {
    setObservedLogs(logsQuery.data);
    setLiveLogs(logsQuery.data ?? []);
  }
  if (observedEvents !== eventsQuery.data) {
    setObservedEvents(eventsQuery.data);
    const rows = (eventsQuery.data ?? [])
      .map(transitionFromRecord)
      .filter((row): row is StateTransitionRow => row !== null)
      .slice(-50)
      .reverse();
    if (rows.length > 0) setTransitions(rows);
  }

  useEffect(() => {
    if (client === null) {
      return undefined;
    }
    return client.subscribe((record) => {
      if (record.kind === "gpio_edge") {
        setLiveGpio((current) => upsertGpioEdge(current, record));
        if (record.role === "rotary_pulse" && record.level) {
          setPulseAccumulator((current) => ({
            ...current,
            currentCount: current.currentCount + 1,
          }));
        }
      }
      const transition = transitionFromRecord(record);
      if (transition !== null) {
        setTransitions((current) => [transition, ...current].slice(0, 50));
        setLiveStatus((current) => updateStatus(current, transition));
      }
      if (record.kind === "digit_dialed") {
        setPulseAccumulator({
          currentCount: 0,
          lastDigit: record.digit,
          lastPulseCount: record.pulses,
        });
      }
      if (record.kind === "audio_level") {
        const channel: AudioChannel = record.channel === "input" ? "input" : "output";
        const receivedAt = Date.now();
        setMeterNow(receivedAt);
        setAudioMeters((current) =>
          recordSample(current, channel, {
            levelDbfs: dbfsFromLinear(record.rms),
            peakDbfs: dbfsFromLinear(record.peak),
            receivedAt,
            staleAfterMs: LIVE_SAMPLE_STALE_AFTER_MS,
          }),
        );
      }
      if (record.kind === "audio_level" || record.kind === "audio_device_change") {
        setLiveAudio((current) => audioMetadata(current, record));
      }
      if (record.kind === "log") {
        setLiveLogs((current) =>
          [
            ...current,
            { ts: record.ts, level: record.level, target: record.target, message: record.message },
          ].slice(-200),
        );
      }
      if (record.kind === "error") {
        setLiveLogs((current) =>
          [
            ...current,
            { ts: record.ts, level: "error", target: record.source, message: record.message },
          ].slice(-200),
        );
      }
    });
  }, [client]);

  const config = configQuery.data;
  const pinLabels = useMemo(() => buildPinLabels(config), [config]);

  const hasMeterSamples = audioMeters.input !== undefined || audioMeters.output !== undefined;
  useEffect(() => {
    if (!hasMeterSamples) {
      return undefined;
    }
    // Staleness and peak decay are functions of wall-clock time, not of
    // incoming events, so the panel schedules its own wake-ups to fall back.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      const delay = nextMeterUpdateDelay(audioMeters, Date.now());
      if (delay === null) {
        return;
      }
      timer = setTimeout(() => {
        setMeterNow(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [audioMeters, hasMeterSamples]);

  const inputMeter = useMemo(
    () => resolveMeter(audioMeters, "input", meterNow),
    [audioMeters, meterNow],
  );
  const outputMeter = useMemo(
    () => resolveMeter(audioMeters, "output", meterNow),
    [audioMeters, meterNow],
  );

  return (
    <GlassPanel title="Phone-booth debug surface" className="debug-screen">
      <p className="screen-kicker">Digit 9</p>
      <h1>Debug</h1>
      <p>
        Operator diagnostics for the phone client. Tailscale is tried first; LAN is the
        pinned-certificate fallback.
      </p>
      <ConnectionStatusBar connection={connection} hasPrefs={hasPrefs} />
      {!hasPrefs ? (
        <p className="debug-callout">
          Configure the Phone Client Connection panel in Settings to open this line.
        </p>
      ) : null}
      <div className="debug-grid">
        <StateMachinePanel status={liveStatus ?? stateQuery.data} transitions={transitions} />
        <GpioPanel
          snapshot={liveGpio ?? gpioQuery.data}
          pulseAccumulator={pulseAccumulator}
          pinLabels={pinLabels}
        />
        <AudioPanel
          audio={liveAudio ?? audioQuery.data?.snapshot}
          input={inputMeter}
          output={outputMeter}
          status={liveStatus ?? stateQuery.data}
        />
        <LogsPanel logs={liveLogs} level={level} onLevelChange={setLevel} />
        <ConfigPanel config={config} />
        <CertFingerprintCard fingerprint={prefs.pinnedFingerprint} />
        <SimulatePanel allowControls={allowControls(config)} client={client} />
      </div>
    </GlassPanel>
  );
}
