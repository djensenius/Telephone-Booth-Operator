import {
  BoothStatusSchema,
  BoothSystemSnapshotEnvelopeSchema,
  WsEnvelopeSchema,
} from "@telephone-booth-operator/shared";
import type { BoothStatus, BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createBusyBarDeviceClient } from "./lib/busy-bar/client.js";
import { resolveBusyBarMonitorConfig } from "./lib/busy-bar/config.js";
import { BusyBarMonitor } from "./lib/busy-bar/monitor.js";
import { log } from "./lib/logger.js";

const websocketUrl = (apiUrl: string): string => {
  const url = new URL("/v1/ws/status", apiUrl);
  url.protocol = "wss:";
  return url.toString();
};

const fetchJson = async (url: URL, token: string): Promise<unknown> => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Operator API returned ${response.status} for ${url.pathname}`);
  }
  return response.json();
};

export const readInitialStatus = async (
  apiUrl: string,
  token: string,
): Promise<BoothStatus | null> => {
  const raw = await fetchJson(new URL("/v1/status", apiUrl), token);
  const parsed = BoothStatusSchema.safeParse(raw);
  return parsed.success && parsed.data.id !== undefined ? parsed.data : null;
};

const readInitialSystem = async (
  apiUrl: string,
  token: string,
  boothId: string,
): Promise<BoothSystemSnapshotEnvelope | null> => {
  const url = new URL("/v1/system/current", apiUrl);
  url.searchParams.set("boothId", boothId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Operator API returned ${response.status} for ${url.pathname}`);
  }
  const raw: unknown = await response.json();
  const parsed = BoothSystemSnapshotEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export interface OperatorStreamHandle {
  stop(): void;
}

export interface BusyBarOperatorMonitor {
  updateStatus(status: BoothStatus, receivedAtMs?: number): void;
  updateSystem(system: BoothSystemSnapshotEnvelope): void;
}

const statusReceiptTime = (status: BoothStatus): number => {
  const reportedAt = Date.parse(status.updatedAt);
  return Number.isFinite(reportedAt) ? Math.min(Date.now(), reportedAt) : Date.now();
};

export const startOperatorStream = (
  apiUrl: string,
  token: string,
  boothId: string,
  monitor: BusyBarOperatorMonitor,
): OperatorStreamHandle => {
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;
  let attempt = 0;

  const connect = (): void => {
    if (stopped) return;
    const current = new WebSocket(websocketUrl(apiUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    socket = current;
    current.on("open", () => {
      attempt = 0;
      log.info("BUSY Bar worker connected to operator status stream");
    });
    current.on("message", (data) => {
      let raw: unknown;
      try {
        const text =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : data instanceof ArrayBuffer
                ? Buffer.from(data).toString("utf8")
                : Buffer.concat(data).toString("utf8");
        raw = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = WsEnvelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.kind === "status") {
        monitor.updateStatus(parsed.data.status);
      } else if (parsed.data.kind === "system" && parsed.data.boothId === boothId) {
        monitor.updateSystem({
          boothId: parsed.data.boothId,
          snapshot: parsed.data.snapshot,
          receivedAt: parsed.data.receivedAt,
          version: parsed.data.version ?? null,
        });
      }
    });
    current.on("error", (error) => {
      log.warn({ err: error }, "BUSY Bar worker operator stream failed");
    });
    current.on("close", (code) => {
      if (socket !== current) return;
      socket = null;
      if (stopped || code === 1008) return;
      const delay = Math.min(30_000, 1_000 * 2 ** attempt);
      attempt += 1;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, delay);
      retry.unref();
    });
  };

  connect();
  return {
    stop(): void {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000, "worker stopped");
    },
  };
};

export const startOperatorPolling = (
  apiUrl: string,
  token: string,
  boothId: string,
  monitor: BusyBarOperatorMonitor,
): OperatorStreamHandle => {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    await Promise.all([
      readInitialStatus(apiUrl, token)
        .then((status) => {
          if (status && !stopped) monitor.updateStatus(status, statusReceiptTime(status));
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, "BUSY Bar worker status poll failed");
        }),
      readInitialSystem(apiUrl, token, boothId)
        .then((system) => {
          if (system && !stopped) monitor.updateSystem(system);
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, "BUSY Bar worker system poll failed");
        }),
    ]);
    polling = false;
  };

  timer = setInterval(() => {
    void poll();
  }, 5_000);
  timer.unref();
  return {
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
};

const waitWhileDisabled = (): Promise<void> =>
  new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const shutdown = (): void => {
      clearInterval(keepAlive);
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
      resolve();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });

const start = async (): Promise<void> => {
  const config = resolveBusyBarMonitorConfig();
  if (!config.enabled) {
    log.info("BUSY Bar worker is disabled; waiting for shutdown");
    await waitWhileDisabled();
    return;
  }
  const monitor = new BusyBarMonitor(config, createBusyBarDeviceClient(config));
  const [status, system] = await Promise.all([
    readInitialStatus(config.operatorApiUrl, config.operatorToken),
    readInitialSystem(config.operatorApiUrl, config.operatorToken, config.boothId),
  ]);
  if (status) monitor.updateStatus(status, statusReceiptTime(status));
  if (system) monitor.updateSystem(system);
  await monitor.start();
  const stream = startOperatorStream(
    config.operatorApiUrl,
    config.operatorToken,
    config.boothId,
    monitor,
  );
  const polling = startOperatorPolling(
    config.operatorApiUrl,
    config.operatorToken,
    config.boothId,
    monitor,
  );
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    stream.stop();
    polling.stop();
    void monitor.stop().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((error: unknown) => {
    log.error({ err: error }, "BUSY Bar worker failed to start");
    process.exitCode = 1;
  });
}
