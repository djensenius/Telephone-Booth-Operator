import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DisplayDrawParams } from "@busy-app/busy-lib";
import type { BoothStatus, BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import type { BusyBarDeviceClient } from "../src/lib/busy-bar/client.js";
import type { BusyBarMonitorConfig } from "../src/lib/busy-bar/config.js";
import { BusyBarMonitor } from "../src/lib/busy-bar/monitor.js";

const config: Extract<BusyBarMonitorConfig, { enabled: true }> = {
  enabled: true,
  token: "busy-token",
  apiUrl: "https://api.busy.app",
  cloudWebSocketUrl: "wss://api.busy.app/api/v1/bars/ws",
  deviceId: null,
  applicationName: "telephone-booth-monitor",
  displayPriority: 100,
  staleAfterMs: 20_000,
  renderDebounceMs: 250,
  frontRotationMs: 8_000,
  audioEnabled: true,
  alertSound: "alert.snd",
  alertCooldownMs: 300_000,
  operatorApiUrl: "https://operator.example.com",
  operatorToken: "operator-token",
};

const status = (state: BoothStatus["state"]): BoothStatus => ({
  state,
  updatedAt: new Date().toISOString(),
  currentQuestionId: null,
  currentMessageId: null,
  lastError: state === "error" ? "test error" : null,
  runtimeMode: "real",
});

const healthySystem = (): BoothSystemSnapshotEnvelope => ({
  boothId: "booth-01",
  snapshot: {
    cpu: { usageRatio: 0.1, loadAvg1m: 0.2, physicalCores: 4 },
    memory: { usedBytes: 500, totalBytes: 1_000 },
    temperatureCelsius: 45,
  },
  receivedAt: new Date().toISOString(),
  version: "0.3.2",
});

const frontText = (payload: DisplayDrawParams): string | undefined =>
  payload.elements.find((element) => element.display === "front" && "text" in element)?.text;

const createClient = (): BusyBarDeviceClient & {
  draw: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  playStockSound: ReturnType<typeof vi.fn>;
} => ({
  resolveDeviceId: vi.fn(() => Promise.resolve(null)),
  draw: vi.fn(() => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve()),
  playStockSound: vi.fn(() => Promise.resolve()),
});

describe("BUSY Bar monitor lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces updates and draws the latest state", async () => {
    const client = createClient();
    const monitor = new BusyBarMonitor(config, client);
    monitor.updateStatus(status("idle"));
    await monitor.start();
    monitor.updateStatus(status("recording"));

    await vi.advanceTimersByTimeAsync(250);

    expect(client.draw).toHaveBeenCalledTimes(1);
    expect(frontText(client.draw.mock.calls[0]?.[0] as DisplayDrawParams)).toBe("RECORDING");
    await monitor.stop();
  });

  it("ignores an older polled status after a live update", async () => {
    const client = createClient();
    const monitor = new BusyBarMonitor(config, client);
    monitor.updateStatus(status("recording"), Date.now());
    monitor.updateStatus(
      { ...status("idle"), updatedAt: new Date(Date.now() - 10_000).toISOString() },
      Date.now() - 10_000,
    );
    await monitor.start();

    await vi.advanceTimersByTimeAsync(250);

    expect(frontText(client.draw.mock.calls[0]?.[0] as DisplayDrawParams)).toBe("RECORDING");
    await monitor.stop();
  });

  it("retries a failed draw and recovers", async () => {
    const client = createClient();
    client.draw.mockRejectedValueOnce(new Error("cloud down")).mockResolvedValue(undefined);
    const monitor = new BusyBarMonitor(
      { ...config, audioEnabled: false, alertSound: null },
      client,
    );
    monitor.updateStatus(status("idle"));
    await monitor.start();

    await vi.advanceTimersByTimeAsync(250);
    expect(client.draw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(client.draw).toHaveBeenCalledTimes(2);
    await monitor.stop();
  });

  it("plays audio only when entering a fault", async () => {
    const client = createClient();
    const monitor = new BusyBarMonitor({ ...config, staleAfterMs: 1_000_000 }, client);
    monitor.updateStatus(status("idle"));
    monitor.updateSystem(healthySystem());
    await monitor.start();
    await vi.advanceTimersByTimeAsync(250);

    monitor.updateStatus(status("error"));
    await vi.advanceTimersByTimeAsync(250);
    expect(client.playStockSound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(config.alertCooldownMs);
    monitor.updateStatus(status("error"));
    await vi.advanceTimersByTimeAsync(250);
    expect(client.playStockSound).toHaveBeenCalledTimes(1);
    await monitor.stop();
  });

  it("waits for alert audio before clearing on stop", async () => {
    let finishAudio: (() => void) | undefined;
    const client = createClient();
    client.playStockSound.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAudio = resolve;
        }),
    );
    const monitor = new BusyBarMonitor(config, client);
    monitor.updateStatus(status("idle"));
    monitor.updateSystem(healthySystem());
    await monitor.start();
    await vi.advanceTimersByTimeAsync(250);
    monitor.updateStatus(status("error"));
    vi.advanceTimersByTime(250);
    await Promise.resolve();

    const stopped = monitor.stop();
    expect(client.clear).not.toHaveBeenCalled();
    finishAudio?.();
    await stopped;
    expect(client.clear).toHaveBeenCalledWith(config.applicationName);
  });

  it("waits for device I/O before clearing on stop", async () => {
    let finishDraw: (() => void) | undefined;
    const client = createClient();
    client.draw.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDraw = resolve;
        }),
    );
    const monitor = new BusyBarMonitor(
      { ...config, audioEnabled: false, alertSound: null },
      client,
    );
    monitor.updateStatus(status("idle"));
    await monitor.start();

    vi.advanceTimersByTime(250);
    await Promise.resolve();
    const stopped = monitor.stop();
    expect(client.clear).not.toHaveBeenCalled();

    finishDraw?.();
    await stopped;
    expect(client.clear).toHaveBeenCalledWith(config.applicationName);
  });
});
