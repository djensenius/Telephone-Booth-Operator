import { aggregateSystemHealthSeverity } from "@telephone-booth-operator/shared";
import type { BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import { randomUUID } from "node:crypto";
import { wsBroadcaster } from "../broadcaster.js";
import { db } from "../db.js";
import { log } from "../logger.js";
import { serializeStatus } from "../serializers.js";
import { listSystemSnapshots } from "../system-cache.js";
import type { BusyBarDeviceClient } from "./client.js";
import { createBusyBarDeviceClient } from "./client.js";
import type { BusyBarMonitorConfig } from "./config.js";
import { resolveBusyBarMonitorConfig } from "./config.js";
import type { BusyBarInputEvent, BusyBarInputStreamHandle } from "./input-stream.js";
import { startBusyBarInputStream } from "./input-stream.js";
import type { BackPage, BusyBarMonitorState } from "./renderer.js";
import { renderBusyBar } from "./renderer.js";

export interface BusyBarMonitorHandle {
  stop(): Promise<void>;
}

const nextPage = (page: BackPage, direction: number): BackPage =>
  ((((page + direction) % 3) + 3) % 3) as BackPage;

class BusyBarMonitor {
  readonly #config: Extract<BusyBarMonitorConfig, { enabled: true }>;
  readonly #client: BusyBarDeviceClient;
  readonly #subscriberId = `busy-bar-${randomUUID()}`;
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
  readonly #lastAlertAt: Record<"error" | "offline", number> = {
    error: 0,
    offline: 0,
  };
  #stopped = false;
  #stopPromise: Promise<void> | null = null;
  #currentAlertKind: "error" | "offline" | null = null;

  constructor(
    config: Extract<BusyBarMonitorConfig, { enabled: true }>,
    client: BusyBarDeviceClient,
  ) {
    this.#config = config;
    this.#client = client;
  }

  async start(): Promise<void> {
    const latestStatus = await db.boothStatusSnapshot.findFirst({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    if (this.#stopped) return;
    this.#state = {
      ...this.#state,
      status: latestStatus ? serializeStatus(latestStatus) : null,
      statusReceivedAtMs: latestStatus
        ? Math.min(Date.now(), latestStatus.updatedAt.getTime())
        : null,
      system: listSystemSnapshots()[0] ?? null,
    };
    wsBroadcaster.subscribe(this.#subscriberId, (event) => {
      if (event.kind === "status") {
        const wasActive = this.#state.status?.state !== "idle";
        this.#state = {
          ...this.#state,
          status: event.status,
          statusReceivedAtMs: Date.now(),
          frontFrame: event.status.state !== "idle" || wasActive ? "state" : this.#state.frontFrame,
        };
        this.#scheduleRender();
      } else if (event.kind === "system") {
        const previousSeverity = aggregateSystemHealthSeverity(this.#state.system?.snapshot);
        const system: BoothSystemSnapshotEnvelope = {
          boothId: event.boothId,
          snapshot: event.snapshot,
          receivedAt: event.receivedAt,
          version: event.version,
        };
        const recovered =
          previousSeverity !== "ok" && aggregateSystemHealthSeverity(system.snapshot) === "ok";
        this.#state = {
          ...this.#state,
          system,
          frontFrame: recovered ? "state" : this.#state.frontFrame,
        };
        this.#scheduleRender();
      }
    });

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
    if (this.#stopped || this.#renderTimer) return;
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
    if (this.#rendering) {
      this.#renderQueued = true;
      return;
    }
    this.#rendering = true;
    try {
      const wasDisconnected = !this.#state.cloudConnected;
      const rendered = renderBusyBar(this.#state, this.#config, Date.now());
      if (rendered.signature !== this.#renderSignature) {
        await this.#client.draw(rendered.payload);
        this.#renderSignature = rendered.signature;
      }
      this.#state = { ...this.#state, cloudConnected: true };
      this.#retryAttempt = 0;
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      void this.#maybeAlert(rendered.alertKind);
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

  async #maybeAlert(kind: "error" | "offline" | null): Promise<void> {
    const previousKind = this.#currentAlertKind;
    this.#currentAlertKind = kind;
    if (
      !kind ||
      kind === previousKind ||
      !this.#config.audioEnabled ||
      !this.#config.alertSound
    ) {
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
    wsBroadcaster.unsubscribe(this.#subscriberId);
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

export const startBusyBarMonitor = (): BusyBarMonitorHandle | null => {
  const config = resolveBusyBarMonitorConfig();
  if (!config.enabled) return null;
  const monitor = new BusyBarMonitor(config, createBusyBarDeviceClient(config));
  void monitor.start().catch((error: unknown) => {
    log.error({ err: error }, "BUSY Bar monitor failed to start");
  });
  return monitor;
};
