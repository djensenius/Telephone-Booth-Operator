import { describe, expect, it } from "vite-plus/test";
import {
  BusyBarConfigurationError,
  resolveBusyBarMonitorConfig,
} from "../src/lib/busy-bar/config.js";

describe("BUSY Bar monitor configuration", () => {
  it("is disabled by default", () => {
    expect(resolveBusyBarMonitorConfig({})).toEqual({ enabled: false });
    expect(() => resolveBusyBarMonitorConfig({ BUSY_BAR_MONITOR_ENABLED: "TRUE" })).toThrow(
      "BUSY_BAR_MONITOR_ENABLED",
    );
  });

  it("requires a token and alert sound when enabled", () => {
    expect(() => resolveBusyBarMonitorConfig({ BUSY_BAR_MONITOR_ENABLED: "true" })).toThrow(
      BusyBarConfigurationError,
    );

    expect(() =>
      resolveBusyBarMonitorConfig({
        BUSY_BAR_MONITOR_ENABLED: "true",
        BUSY_BAR_CLOUD_TOKEN: "secret-token",
        BUSY_BAR_OPERATOR_API_URL: "https://operator.example.com",
        BUSY_BAR_OPERATOR_TOKEN: "operator-token",
      }),
    ).toThrow("BUSY_BAR_ALERT_SOUND");

    expect(() =>
      resolveBusyBarMonitorConfig({
        BUSY_BAR_MONITOR_ENABLED: "true",
        BUSY_BAR_CLOUD_TOKEN: "secret-token",
        BUSY_BAR_OPERATOR_TOKEN: "operator-token",
        BUSY_BAR_ALERT_SOUND: "alert.snd",
      }),
    ).toThrow("BUSY_BAR_OPERATOR_API_URL");
  });

  it("resolves safe defaults without exposing the token in errors", () => {
    const config = resolveBusyBarMonitorConfig({
      BUSY_BAR_MONITOR_ENABLED: "true",
      BUSY_BAR_CLOUD_TOKEN: "secret-token",
      BUSY_BAR_OPERATOR_API_URL: "https://operator.example.com",
      BUSY_BAR_OPERATOR_TOKEN: "operator-token",
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
      operatorApiUrl: "https://operator.example.com",
    });
  });

  it("validates bounded numeric settings and URL protocols", () => {
    const base = {
      BUSY_BAR_MONITOR_ENABLED: "true",
      BUSY_BAR_CLOUD_TOKEN: "secret-token",
      BUSY_BAR_OPERATOR_API_URL: "https://operator.example.com",
      BUSY_BAR_OPERATOR_TOKEN: "operator-token",
      BUSY_BAR_ALERT_SOUND: "alert.snd",
    };
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_DISPLAY_PRIORITY: "101" }),
    ).toThrow("BUSY_BAR_DISPLAY_PRIORITY");
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_CLOUD_WS_URL: "https://example.com/ws" }),
    ).toThrow("BUSY_BAR_CLOUD_WS_URL");
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_FRONT_ROTATION_SECONDS: "8seconds" }),
    ).toThrow("BUSY_BAR_FRONT_ROTATION_SECONDS");
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_API_URL: "http://api.busy.app" }),
    ).toThrow("BUSY_BAR_API_URL");
    expect(() =>
      resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_OPERATOR_API_URL: "http://operator.local" }),
    ).toThrow("BUSY_BAR_OPERATOR_API_URL");
    expect(() => resolveBusyBarMonitorConfig({ ...base, BUSY_BAR_AUDIO_ENABLED: "flase" })).toThrow(
      "BUSY_BAR_AUDIO_ENABLED",
    );
  });
});
