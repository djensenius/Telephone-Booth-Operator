import { describe, expect, it } from "vite-plus/test";
import type { DisplayDrawParams } from "@busy-app/busy-lib";
import type { BoothStatus, BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import type { BusyBarMonitorConfig } from "../src/lib/busy-bar/config.js";
import type { BusyBarMonitorState } from "../src/lib/busy-bar/renderer.js";
import { renderBusyBar } from "../src/lib/busy-bar/renderer.js";

const now = Date.parse("2026-07-31T20:00:00.000Z");

const config: Extract<BusyBarMonitorConfig, { enabled: true }> = {
  enabled: true,
  token: "secret",
  apiUrl: "https://api.busy.app",
  cloudWebSocketUrl: "wss://api.busy.app/api/v1/bars/ws",
  boothId: "booth-01",
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
  updatedAt: new Date(now - 1_000).toISOString(),
  currentQuestionId: null,
  currentMessageId: null,
  lastError: null,
  runtimeMode: "real",
});

const system: BoothSystemSnapshotEnvelope = {
  boothId: "booth-01",
  snapshot: {
    temperatureCelsius: 45,
    cpu: { usageRatio: 0.2, loadAvg1m: 0.4, physicalCores: 4 },
    memory: { usedBytes: 500, totalBytes: 1_000 },
    tailscale: { connected: true, peerCount: 2, hostname: "booth" },
  },
  receivedAt: new Date(now - 1_000).toISOString(),
  version: "0.3.2",
};

const model = (overrides: Partial<BusyBarMonitorState> = {}): BusyBarMonitorState => ({
  status: status("idle"),
  statusReceivedAtMs: now - 1_000,
  system,
  frontFrame: "state",
  backPage: 0,
  cloudConnected: true,
  ...overrides,
});

const textsFor = (payload: DisplayDrawParams, display: "front" | "back"): string[] =>
  payload.elements.flatMap((element) =>
    element.display === display && "text" in element ? [element.text] : [],
  );

describe("BUSY Bar renderer", () => {
  it("rotates READY to SYSTEM OK only while idle", () => {
    expect(textsFor(renderBusyBar(model(), config, now).payload, "front")).toEqual(["READY"]);
    expect(
      textsFor(renderBusyBar(model({ frontFrame: "health" }), config, now).payload, "front"),
    ).toEqual(["SYSTEM OK"]);
    expect(
      textsFor(
        renderBusyBar(model({ status: status("recording"), frontFrame: "health" }), config, now)
          .payload,
        "front",
      ),
    ).toEqual(["RECORDING"]);
  });

  it("pins critical health and offline frames", () => {
    const hot = renderBusyBar(
      model({
        system: {
          ...system,
          snapshot: { ...system.snapshot, temperatureCelsius: 80 },
        },
      }),
      config,
      now,
    );
    expect(textsFor(hot.payload, "front")).toEqual(["HOT"]);
    expect(hot.alertKind).toBe("critical");

    const offline = renderBusyBar(
      model({
        statusReceivedAtMs: now - 30_000,
      }),
      config,
      now,
    );
    expect(textsFor(offline.payload, "front")).toEqual(["OFFLINE"]);
    expect(offline.alertKind).toBe("offline");

    const staleSystem = renderBusyBar(
      model({
        system: { ...system, receivedAt: new Date(now - 30_000).toISOString() },
      }),
      config,
      now,
    );
    expect(textsFor(staleSystem.payload, "front")).toEqual(["OFFLINE"]);
    expect(staleSystem.alertKind).toBe("offline");

    const activeWithStaleSystem = renderBusyBar(
      model({
        status: status("recording"),
        system: { ...system, receivedAt: new Date(now - 30_000).toISOString() },
      }),
      config,
      now,
    );
    expect(textsFor(activeWithStaleSystem.payload, "front")).toEqual(["RECORDING"]);
    expect(activeWithStaleSystem.alertKind).toBe("offline");

    const throttledCritical = renderBusyBar(
      model({
        system: {
          ...system,
          snapshot: {
            ...system.snapshot,
            tailscale: { connected: false },
            throttling: { undervoltage: true },
          },
        },
      }),
      config,
      now,
    );
    expect(textsFor(throttledCritical.payload, "front")).toEqual(["SYSTEM CRIT"]);
    expect(throttledCritical.alertKind).toBe("critical");
  });

  it("keeps the front signature stable during back-page navigation", () => {
    const callPage = renderBusyBar(model({ backPage: 0 }), config, now);
    const systemPage = renderBusyBar(model({ backPage: 1 }), config, now);
    expect(systemPage.frontSignature).toBe(callPage.frontSignature);
    expect(systemPage.backSignature).not.toBe(callPage.backSignature);
    expect(textsFor(systemPage.payload, "back")[0]).toBe("SYSTEM");
  });

  it("uses printable bounded front labels and priority 100", () => {
    const rendered = renderBusyBar(
      model({
        status: {
          ...status("error"),
          lastError: "bad \u2603 control",
        },
      }),
      config,
      now,
    );
    expect(textsFor(rendered.payload, "front")).toEqual(["ERROR"]);
    expect(rendered.payload.priority).toBe(100);
    expect(rendered.payload.elements.some((element) => element.display === "front")).toBe(true);
    expect(rendered.payload.elements.some((element) => element.display === "back")).toBe(true);
  });
});
