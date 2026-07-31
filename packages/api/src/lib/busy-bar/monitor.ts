import { aggregateSystemHealthSeverity } from "@telephone-booth-operator/shared";
import type { BoothStatus, BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import { log } from "../logger.js";
import type { BusyBarDeviceClient } from "./client.js";
import type { BusyBarMonitorConfig } from "./config.js";
import type { BusyBarInputEvent, BusyBarInputStreamHandle } from "./input-stream.js";
import { startBusyBarInputStream } from "./input-stream.js";
import type { BackPage, BusyBarMonitorState } from "./renderer.js";
import { renderBusyBar } from "./renderer.js";

export interface BusyBarMonitorHandle {
  stop(): Promise<void>;
}

const nextPage = (page: BackPage, direction: number): BackPage =>
  ((((page + direction) % 3) + 3) % 3) as BackPage;

export class BusyBarMonitor {
  readonly #config: Extract<BusyBarMonitorConfig, { enabled: true }>;
  readonly #client: BusyBarDeviceClient;
  #state: BusyBarMonitorState = {
    status: null,
    statusReceivedAtMs: null,
    system: null,
    frontFrame: "state",
    backPage: 0,
    cloudConnected: false,
  };
  #renderTimer: NodeJS.Timeout | null = null;
  #freshnessTimer: NodeJS.Timeout | null = null;
  #rotationTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #inputStream: BusyBarInputStreamHandle | null = null;
  #rendering = false;
  #renderQueued = false;
  #activeRender: Promise<void> | null = null;
  #retryAttempt = 0;
  #renderSignature: string | null = null;
  readonly #lastAlertAt: Record<"error" | "offline" | "critical", number> = {
    error: 0,
    offline: 0,
    critical: 0,
  };
  #stopped = false;
  #started = false;
  #stopPromise: Promise<void> | null = null;
  #currentAlertKind: "error" | "offline" | "critical" | null = null;
  #statusSourceAtMs: number | null = null;
  #statusSourceId: number | null = null;
  #systemSourceAtMs: number | null = null;

  constructor(
    config: Extract<BusyBarMonitorConfig, { enabled: true }>,
    client: BusyBarDeviceClient,
  ) {
    this.#config = config;
    this.#client = client;
  }

  async start(): Promise<void> {
    this.#started = true;
    this.#freshnessTimer = setInterval(() => this.#scheduleRender(), 5_000);
    this.#freshnessTimer.unref();
    this.#rotationTimer = setInterval(() => {
      if (this.#state.status?.state !== "idle") return;
      this.#state = {
        ...this.#state,
        frontFrame: this.#state.frontFrame === "state" ? "health" : "state",
      };
      this.#scheduleRender();
    }, this.#config.frontRotationMs);
    this.#rotationTimer.unref();

    const deviceId = await this.#client.resolveDeviceId();
    if (this.#stopped) return;
    this.#state = { ...this.#state, cloudConnected: true };
    if (deviceId) {
      this.#inputStream = startBusyBarInputStream({
        url: this.#config.cloudWebSocketUrl,
        token: this.#config.token,
        deviceId,
        onInput: (event) => this.#handleInput(event),
        onStatus: (connected) => {
          log.info({ connected }, "BUSY Bar input stream state changed");
        },
        onError: (error) => {
          log.warn({ err: error }, "BUSY Bar input stream failed");
        },
      });
    } else {
      log.warn("BUSY_BAR_DEVICE_ID is not configured; input navigation is disabled");
    }
    this.#scheduleRender();
    log.info("BUSY Bar monitor started");
  }

  updateStatus(status: BoothStatus, receivedAtMs = Date.now()): void {
    const reportedAtMs = Date.parse(status.updatedAt);
    const sourceAtMs = Math.min(
      Number.isFinite(reportedAtMs) ? reportedAtMs : receivedAtMs,
      receivedAtMs,
      Date.now(),
    );
    if (this.#statusSourceAtMs !== null) {
      if (sourceAtMs < this.#statusSourceAtMs) return;
      if (
        sourceAtMs === this.#statusSourceAtMs &&
        this.#statusSourceId !== null &&
        (status.id === undefined || status.id < this.#statusSourceId)
      ) {
        return;
      }
    }
    const wasActive = this.#state.status?.state !== "idle";
    const cappedReceivedAtMs = Math.min(receivedAtMs, Date.now());
    this.#statusSourceAtMs = sourceAtMs;
    this.#statusSourceId = status.id ?? null;
    this.#state = {
      ...this.#state,
      status,
      statusReceivedAtMs: Math.max(this.#state.statusReceivedAtMs ?? 0, cappedReceivedAtMs),
      frontFrame: status.state !== "idle" || wasActive ? "state" : this.#state.frontFrame,
    };
    this.#scheduleRender();
  }

  updateSystem(system: BoothSystemSnapshotEnvelope): void {
    const receivedAtMs = Date.parse(system.receivedAt);
    const sourceAtMs = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
    if (this.#systemSourceAtMs !== null && sourceAtMs < this.#systemSourceAtMs) return;
    const previousSeverity = aggregateSystemHealthSeverity(this.#state.system?.snapshot);
    const recovered =
      previousSeverity !== "ok" && aggregateSystemHealthSeverity(system.snapshot) === "ok";
    this.#systemSourceAtMs = sourceAtMs;
    this.#state = {
      ...this.#state,
      system,
      frontFrame: recovered ? "state" : this.#state.frontFrame,
    };
    this.#scheduleRender();
  }

  #handleInput(event: BusyBarInputEvent): void {
    if (event.kind === "switch") return;
    if (event.kind === "button") {
      if (event.action !== "PRESS") return;
      this.#state = {
        ...this.#state,
        backPage: event.button === "BACK" ? 0 : nextPage(this.#state.backPage, 1),
      };
    } else {
      this.#state = {
        ...this.#state,
        backPage: nextPage(this.#state.backPage, event.delta > 0 ? 1 : -1),
      };
    }
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (!this.#started || this.#stopped || this.#renderTimer || this.#retryTimer) return;
    if (this.#rendering) {
      this.#renderQueued = true;
      return;
    }
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      const render = this.#render();
      this.#activeRender = render;
      void render.finally(() => {
        if (this.#activeRender === render) this.#activeRender = null;
      });
    }, this.#config.renderDebounceMs);
    this.#renderTimer.unref();
  }

  async #render(): Promise<void> {
    this.#rendering = true;
    try {
      const wasDisconnected = !this.#state.cloudConnected;
      const rendered = renderBusyBar(
        wasDisconnected ? { ...this.#state, cloudConnected: true } : this.#state,
        this.#config,
        Date.now(),
      );
      if (wasDisconnected || rendered.signature !== this.#renderSignature) {
        await this.#client.draw(rendered.payload);
        this.#renderSignature = rendered.signature;
      }
      this.#state = { ...this.#state, cloudConnected: true };
      this.#retryAttempt = 0;
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      await this.#maybeAlert(rendered.alertKind);
      if (wasDisconnected) {
        this.#state = { ...this.#state, frontFrame: "state" };
        this.#scheduleRender();
      }
    } catch (error) {
      this.#state = { ...this.#state, cloudConnected: false };
      log.warn({ err: error }, "BUSY Bar render failed");
      this.#scheduleRetry();
    } finally {
      this.#rendering = false;
      if (this.#renderQueued) {
        this.#renderQueued = false;
        this.#scheduleRender();
      }
    }
  }

  async #maybeAlert(kind: "error" | "offline" | "critical" | null): Promise<void> {
    const previousKind = this.#currentAlertKind;
    this.#currentAlertKind = kind;
    if (!kind || kind === previousKind || !this.#config.audioEnabled || !this.#config.alertSound) {
      return;
    }
    const now = Date.now();
    if (now - this.#lastAlertAt[kind] < this.#config.alertCooldownMs) return;
    this.#lastAlertAt[kind] = now;
    try {
      await this.#client.playStockSound(this.#config.applicationName, this.#config.alertSound);
    } catch (error) {
      log.warn({ err: error, kind }, "BUSY Bar alert audio failed");
    }
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.#retryAttempt);
    this.#retryAttempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#scheduleRender();
    }, delay);
    this.#retryTimer.unref();
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    if (this.#freshnessTimer) clearInterval(this.#freshnessTimer);
    if (this.#rotationTimer) clearInterval(this.#rotationTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#inputStream?.stop();
    this.#stopPromise = (async () => {
      if (this.#activeRender) await this.#activeRender;
      try {
        await this.#client.clear(this.#config.applicationName);
      } catch (error) {
        log.warn({ err: error }, "BUSY Bar monitor display cleanup failed");
      }
    })();
    return this.#stopPromise;
  }
}
