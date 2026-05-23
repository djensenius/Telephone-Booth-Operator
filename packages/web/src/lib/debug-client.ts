export type DebugTransport = "tailscale" | "lan" | "disconnected";
export type DebugWebSocketState = "idle" | "connecting" | "open" | "closed" | "error";

export interface DebugConnectionChange {
  readonly transport: DebugTransport;
  readonly latencyMs: number | null;
  readonly wsState: DebugWebSocketState;
  readonly lastError?: string;
}

export interface BoothStatus {
  readonly state: string;
  readonly updatedAt: string;
  readonly currentQuestionId: string | null;
  readonly currentMessageId: string | null;
  readonly lastError: string | null;
}

export type PinRole = string;

export interface GpioPinSnapshot {
  readonly role: PinRole;
  readonly level: boolean;
  readonly debouncedState: boolean;
  readonly lastEdgeMonotonicNs: number;
  readonly lastEventId: number;
}

export interface GpioSnapshot {
  readonly pins: readonly GpioPinSnapshot[];
  readonly updatedAt: string | null;
}

export interface AudioMeter {
  readonly inputLevelDbfs: number;
  readonly outputLevelDbfs: number;
  readonly inputPeakDbfs: number;
  readonly outputPeakDbfs: number;
  readonly currentDevice: string | null;
  readonly sampleRateHz: number | null;
  readonly updatedAt: string | null;
}

export interface LogEntry {
  readonly ts: string;
  readonly level: string;
  readonly target: string;
  readonly message: string;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface DebugConfigProjection {
  readonly tailscaleEnabled?: boolean;
  readonly lanEnabled?: boolean;
  readonly allowControls?: boolean;
  readonly ringBufferCapacity?: number;
  readonly operatorOrigin?: string | null;
  readonly loopbackSkipAuth?: boolean;
}

export interface RedactedConfig extends JsonObject {
  readonly gpio?: JsonValue;
  readonly audio?: JsonValue;
  readonly operator?: JsonValue;
  readonly debug?: DebugConfigProjection & JsonObject;
}

export type CoreEvent =
  | { readonly event: "hook_on" }
  | { readonly event: "hook_off" }
  | { readonly event: "rotary_pulse" }
  | { readonly event: "playback_ended" }
  | { readonly event: "tick" }
  | { readonly event: "digit_dialed"; readonly digit: number }
  | { readonly event: "recording_finished"; readonly recording_id: string }
  | { readonly event: "upload_complete" }
  | { readonly event: "upload_failed"; readonly reason: string }
  | { readonly event: "question_ready"; readonly question_id: string }
  | { readonly event: "question_failed"; readonly reason: string }
  | { readonly event: "message_ready" }
  | { readonly event: "message_failed"; readonly reason: string };

export type TelemetryRecord =
  | ({ readonly id: number; readonly ts: string; readonly kind: "gpio_edge" } & {
      readonly role: PinRole;
      readonly level: boolean;
      readonly at_monotonic_ns: number;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "digit_dialed" } & {
      readonly digit: number;
      readonly pulses: number;
      readonly at_monotonic_ns: number;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "state_transition" } & {
      readonly from: string;
      readonly to: string;
      readonly cause: string;
      readonly at_monotonic_ns: number;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "audio_level" } & {
      readonly channel: string;
      readonly peak: number;
      readonly rms: number;
      readonly at_monotonic_ns: number;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "audio_device_change" } & {
      readonly name: string;
      readonly channel: string;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "log" } & {
      readonly level: string;
      readonly target: string;
      readonly message: string;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "error" } & {
      readonly source: string;
      readonly message: string;
    })
  | ({ readonly id: number; readonly ts: string; readonly kind: "operator_request" | "operator_response" } & JsonObject);

export interface DebugConnectionPrefs {
  readonly tailscaleUrl: string;
  readonly lanUrl: string;
  readonly token: string;
  readonly pinnedFingerprint: string;
  readonly updatedAt: string;
}

export interface CreateDebugClientOptions {
  readonly tailscaleUrl?: string;
  readonly lanUrl?: string;
  readonly token?: string;
  readonly pinnedFingerprint?: string;
  readonly onConnectionChanged?: (change: DebugConnectionChange) => void;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketFactory?: typeof WebSocket;
  readonly failureThreshold?: number;
  readonly timeoutMs?: number;
}

export interface DebugClient {
  readonly getHealth: () => Promise<{ readonly ok: boolean; readonly version: string }>;
  readonly getState: () => Promise<BoothStatus>;
  readonly getEvents: (since?: number) => Promise<readonly TelemetryRecord[]>;
  readonly getGpio: () => Promise<GpioSnapshot>;
  readonly getAudio: () => Promise<AudioMeter>;
  readonly getLogs: (opts?: { readonly level?: string; readonly limit?: number }) => Promise<readonly LogEntry[]>;
  readonly getConfig: () => Promise<RedactedConfig>;
  readonly getLanCertificateFingerprint: () => Promise<string>;
  readonly simulateEvent: (event: CoreEvent) => Promise<{ readonly accepted: boolean; readonly injected: number }>;
  readonly simulatePulse: (count: number) => Promise<{ readonly accepted: boolean; readonly injected: number }>;
  readonly subscribe: (onEvent: (record: TelemetryRecord) => void) => () => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEBUG_STORAGE_PREFIX = "booth.debugConn";

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function queryString(params: URLSearchParams): string {
  const text = params.toString();
  return text.length === 0 ? "" : `?${text}`;
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wsUrlFromBase(baseUrl: string, path: string): string {
  const url = new URL(`${baseUrl}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseJsonRecord(value: unknown): TelemetryRecord | null {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("id" in value)) {
    return null;
  }
  return value as TelemetryRecord;
}

export function getDebugConnectionStorageKey(userSub = "anonymous"): string {
  return `${DEBUG_STORAGE_PREFIX}.${userSub}`;
}

export function readDebugConnectionPrefs(userSub = "anonymous"): DebugConnectionPrefs {
  if (typeof window === "undefined") {
    return emptyDebugConnectionPrefs();
  }
  try {
    const raw = window.localStorage.getItem(getDebugConnectionStorageKey(userSub));
    if (raw === null) {
      return emptyDebugConnectionPrefs();
    }
    const parsed = JSON.parse(raw) as Partial<DebugConnectionPrefs>;
    return {
      tailscaleUrl: parsed.tailscaleUrl ?? "",
      lanUrl: parsed.lanUrl ?? "",
      token: parsed.token ?? "",
      pinnedFingerprint: parsed.pinnedFingerprint ?? "",
      updatedAt: parsed.updatedAt ?? "",
    };
  } catch {
    return emptyDebugConnectionPrefs();
  }
}

export function writeDebugConnectionPrefs(prefs: DebugConnectionPrefs, userSub = "anonymous"): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(getDebugConnectionStorageKey(userSub), JSON.stringify(prefs));
}

export function forgetDebugConnectionPrefs(userSub = "anonymous"): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(getDebugConnectionStorageKey(userSub));
}

export function emptyDebugConnectionPrefs(): DebugConnectionPrefs {
  return {
    tailscaleUrl: "",
    lanUrl: "",
    token: "",
    pinnedFingerprint: "",
    updatedAt: "",
  };
}

export function createDebugClient(options: CreateDebugClientOptions): DebugClient {
  const tailscaleUrl = normalizeBaseUrl(options.tailscaleUrl);
  const lanUrl = normalizeBaseUrl(options.lanUrl);
  const token = options.token?.trim() ?? "";
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let activeTransport: Exclude<DebugTransport, "disconnected"> | "disconnected" = tailscaleUrl === undefined ? (lanUrl === undefined ? "disconnected" : "lan") : "tailscale";
  let tailscaleFailures = 0;
  let wsState: DebugWebSocketState = "idle";
  let lastLatencyMs: number | null = null;

  function baseFor(transport: Exclude<DebugTransport, "disconnected">): string | undefined {
    return transport === "tailscale" ? tailscaleUrl : lanUrl;
  }

  function emit(change: Partial<DebugConnectionChange> = {}): void {
    options.onConnectionChanged?.({
      transport: activeTransport,
      latencyMs: lastLatencyMs,
      wsState,
      ...change,
    });
  }

  function headers(jsonBody: boolean): Headers {
    const requestHeaders = new Headers();
    if (jsonBody) {
      requestHeaders.set("Content-Type", "application/json");
    }
    if (token.length > 0) {
      requestHeaders.set("Authorization", `Bearer ${token}`);
    }
    return requestHeaders;
  }

  async function attempt<T>(transport: Exclude<DebugTransport, "disconnected">, path: string, init: RequestInit = {}): Promise<T> {
    const base = baseFor(transport);
    if (base === undefined) {
      throw new Error(`${transport} URL is not configured`);
    }
    const controller = new AbortController();
    const started = nowMs();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestInit: RequestInit = { ...init, signal: controller.signal };
      if (init.headers !== undefined) {
        requestInit.headers = init.headers;
      }
      const response = await fetchImpl(`${base}${path}`, requestInit);
      lastLatencyMs = Math.round(nowMs() - started);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }
      activeTransport = transport;
      if (transport === "tailscale") {
        tailscaleFailures = 0;
      }
      emit();
      return (await response.json()) as T;
    } catch (error) {
      if (transport === "tailscale") {
        tailscaleFailures += 1;
      }
      emit({ lastError: errorMessage(error), transport: activeTransport });
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const preferred = activeTransport === "disconnected" ? (tailscaleUrl === undefined ? "lan" : "tailscale") : activeTransport;
    if (preferred === "tailscale") {
      try {
        return await attempt<T>("tailscale", path, init);
      } catch (error) {
        if (lanUrl !== undefined && tailscaleFailures >= failureThreshold) {
          return attempt<T>("lan", path, init);
        }
        activeTransport = lanUrl === undefined && tailscaleUrl === undefined ? "disconnected" : activeTransport;
        emit({ lastError: errorMessage(error) });
        throw error;
      }
    }
    if (preferred === "lan") {
      return attempt<T>("lan", path, init);
    }
    activeTransport = "disconnected";
    emit({ lastError: "No debug URL is configured" });
    throw new Error("No debug URL is configured");
  }

  function post<T>(path: string, body: JsonObject): Promise<T> {
    return request<T>(path, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
    });
  }

  return {
    getHealth: () => request<{ readonly ok: boolean; readonly version: string }>("/healthz", { headers: headers(false) }),
    getState: () => request<BoothStatus>("/v1/state", { headers: headers(false) }),
    getEvents: (since?: number) => {
      const params = new URLSearchParams();
      if (since !== undefined) {
        params.set("since", String(since));
      }
      return request<readonly TelemetryRecord[]>(`/v1/events${queryString(params)}`, { headers: headers(false) });
    },
    getGpio: () => request<GpioSnapshot>("/v1/gpio", { headers: headers(false) }),
    getAudio: () => request<AudioMeter>("/v1/audio", { headers: headers(false) }),
    getLogs: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.level !== undefined && opts.level !== "all") {
        params.set("level", opts.level);
      }
      if (opts.limit !== undefined) {
        params.set("limit", String(opts.limit));
      }
      return request<readonly LogEntry[]>(`/v1/logs${queryString(params)}`, { headers: headers(false) });
    },
    getConfig: () => request<RedactedConfig>("/v1/config", { headers: headers(false) }),
    getLanCertificateFingerprint: async () => {
      const response = await attempt<{ readonly sha256: string }>("tailscale", "/v1/cert/fingerprint", { headers: headers(false) });
      return response.sha256;
    },
    simulateEvent: (event: CoreEvent) => post<{ readonly accepted: boolean; readonly injected: number }>("/v1/simulate/event", event),
    simulatePulse: (count: number) => post<{ readonly accepted: boolean; readonly injected: number }>("/v1/simulate/pulse", { count }),
    subscribe: (onEvent: (record: TelemetryRecord) => void) => {
      const WebSocketCtor = options.webSocketFactory ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
      if (WebSocketCtor === undefined) {
        wsState = "closed";
        emit();
        return () => undefined;
      }
      const SocketCtor = WebSocketCtor;
      let stopped = false;
      let socket: WebSocket | null = null;
      let reconnectTimer: number | undefined;
      let retryMs = 1_000;
      let lastSeenId: number | undefined;

      function scheduleReconnect(): void {
        if (stopped) {
          return;
        }
        const wait = retryMs;
        retryMs = Math.min(retryMs * 2, 16_000);
        reconnectTimer = window.setTimeout(connect, wait);
      }

      function connect(): void {
        const transport = activeTransport === "disconnected" ? (tailscaleUrl === undefined ? "lan" : "tailscale") : activeTransport;
        const base = transport === "tailscale" ? tailscaleUrl : lanUrl;
        if (base === undefined) {
          wsState = "closed";
          activeTransport = "disconnected";
          emit({ lastError: "No debug URL is configured" });
          return;
        }
        activeTransport = transport;
        wsState = "connecting";
        emit();
        const protocols = token.length > 0 ? [`bearer.${token}`] : undefined;
        socket = protocols === undefined ? new SocketCtor(wsUrlFromBase(base, "/v1/ws/telemetry")) : new SocketCtor(wsUrlFromBase(base, "/v1/ws/telemetry"), protocols);
        socket.addEventListener("open", () => {
          wsState = "open";
          retryMs = 1_000;
          emit();
          if (lastSeenId !== undefined) {
            socket?.send(JSON.stringify({ replay_from: lastSeenId }));
          }
        });
        socket.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            return;
          }
          const record = parseJsonRecord(JSON.parse(event.data) as unknown);
          if (record === null) {
            return;
          }
          lastSeenId = record.id;
          onEvent(record);
        });
        socket.addEventListener("error", () => {
          wsState = "error";
          emit({ lastError: "Telemetry socket error" });
          socket?.close();
        });
        socket.addEventListener("close", () => {
          wsState = stopped ? "closed" : "closed";
          emit();
          scheduleReconnect();
        });
      }

      connect();
      return () => {
        stopped = true;
        if (reconnectTimer !== undefined) {
          window.clearTimeout(reconnectTimer);
        }
        socket?.close();
        wsState = "closed";
        emit();
      };
    },
  };
}
