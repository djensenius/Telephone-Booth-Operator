import { describe, expect, it } from "vite-plus/test";
import {
  BusyBarConfigurationError,
  resolveBusyBarMonitorConfig,
} from "../src/lib/busy-bar/config.js";

describe("BUSY Bar monitor configuration", () => {
  it("is disabled by default", () => {
    expect(resolveBusyBarMonitorConfig({})).toEqual({ enabled: false });
  });

  it("requires a token and alert sound when enabled", () => {
    expect(() => resolveBusyBarMonitorConfig({ BUSY_BAR_MONITOR_ENABLED: "true" })).toThrow(
      BusyBarConfigurationError,
    );

    expect(() =>
      resolveBusyBarMonitorConfig({
        BUSY_BAR_MONITOR_ENABLED: "true",
        BUSY_BAR_CLOUD_TOKEN: "secret-token",
      }),
    ).toThrow("BUSY_BAR_ALERT_SOUND");
  });

  it("resolves safe defaults without exposing the token in errors", () => {
    const config = resolveBusyBarMonitorConfig({
      BUSY_BAR_MONITOR_ENABLED: "true",
      BUSY_BAR_CLOUD_TOKEN: "secret-token",
      BUSY_BAR_ALERT_SOUND: "alert.snd",
    });

    expect(config).toMatchObject({
      enabled: true,
      apiUrl: "https://api.busy.app",
      cloudWebSocketUrl: "wss://api.busy.app/api/v1/bars/ws",
      displayPriority: 100,
      staleAfterMs: 20_000,
      frontRotationMs: 8_000,
      alertCooldownMs: 300_000,
    });
  });

  it("validates bounded numeric settings and URL protocols", () => {
    const base = {
      BUSY_BAR_MONITOR_ENABLED: "true",
      BUSY_BAR_CLOUD_TOKEN: "secret-token",
      BUSY_BAR_ALERT_SOUND: "alert.snd",
    };
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_DISPLAY_PRIORITY: "101" }),
    ).toThrow("BUSY_BAR_DISPLAY_PRIORITY");
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_CLOUD_WS_URL: "https://example.com/ws" }),
    ).toThrow("BUSY_BAR_CLOUD_WS_URL");
  });
});
