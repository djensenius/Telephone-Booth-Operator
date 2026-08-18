import { describe, expect, it } from "vite-plus/test";
import type {
  BoothSystemSnapshotEnvelope,
  TelemetrySourceEnvelope,
  ThermalHistory,
} from "@telephone-booth-operator/shared";
import { thermalRangeBounds } from "../../lib/api-client.js";
import {
  buildFleetThermalSummaries,
  selectPreferredTelemetrySource,
  shapeThermalCharts,
} from "./thermal-data.js";

const source = (
  id: string,
  boothId: string,
  componentId: string,
  overrides: Partial<TelemetrySourceEnvelope> = {},
): TelemetrySourceEnvelope => ({
  id,
  boothId,
  componentId,
  displayName: `${boothId} router`,
  kind: "router",
  prometheusJob: "glinet-router",
  prometheusInstance: `${boothId}-${componentId}`,
  latestSnapshot: null,
  capturedAt: null,
  receivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("thermal source selection", () => {
  const alpha = source("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "booth-01", "alpha");
  const router = source("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "booth-02", "router");
  const beta = source("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "booth-01", "beta");

  it("keeps an explicit selection, then prefers componentId=router", () => {
    expect(selectPreferredTelemetrySource([alpha, router, beta], beta.id)?.id).toBe(beta.id);
    expect(selectPreferredTelemetrySource([beta, alpha, router])?.id).toBe(router.id);
  });

  describe("thermal history range", () => {
    it("uses a live 24-hour default window with a bounded point count", () => {
      const bounds = thermalRangeBounds("24h", new Date("2026-08-18T00:00:00.000Z"));
      expect(bounds).toEqual({
        from: "2026-08-17T00:00:00.000Z",
        to: "2026-08-18T00:00:00.000Z",
        stepSeconds: 60,
      });
    });
  });

  it("falls back to booth/component/id ordering when no canonical router exists", () => {
    expect(selectPreferredTelemetrySource([beta, alpha])?.id).toBe(alpha.id);
  });
});

describe("thermal current shaping", () => {
  it("joins host and router current data and selects the hottest zone", () => {
    const router = source("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "booth-01", "router", {
      latestSnapshot: {
        battery: { temperatureCelsius: 31.5 },
        thermalZones: [
          { name: "wifi", temperatureCelsius: 48 },
          { name: "soc", temperatureCelsius: 55.25 },
        ],
      },
      receivedAt: "2026-08-18T00:00:05.000Z",
    });
    const systems: BoothSystemSnapshotEnvelope[] = [
      {
        boothId: "booth-01",
        snapshot: { temperatureCelsius: 49.75 },
        receivedAt: "2026-08-18T00:00:06.000Z",
      },
    ];
    const [summary] = buildFleetThermalSummaries(
      [router],
      systems,
      Date.parse("2026-08-18T00:01:00.000Z"),
    );
    expect(summary).toMatchObject({
      piCpuTemperatureCelsius: 49.75,
      routerBatteryTemperatureCelsius: 31.5,
      hottestRouterZone: { name: "soc", temperatureCelsius: 55.25 },
      lastSeenAt: "2026-08-18T00:00:05.000Z",
      offline: false,
    });
  });

  it("does not let fresh host telemetry hide an offline router source", () => {
    const router = source("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "booth-01", "router", {
      receivedAt: "2026-08-18T00:00:00.000Z",
    });
    const systems: BoothSystemSnapshotEnvelope[] = [
      {
        boothId: "booth-01",
        snapshot: { temperatureCelsius: 49.75 },
        receivedAt: "2026-08-18T00:09:59.000Z",
      },
    ];

    const [summary] = buildFleetThermalSummaries(
      [router],
      systems,
      Date.parse("2026-08-18T00:10:00.000Z"),
    );

    expect(summary).toMatchObject({
      lastSeenAt: "2026-08-18T00:00:00.000Z",
      offline: true,
    });
  });

  it("does not present stale host temperature alongside a fresh router", () => {
    const router = source("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "booth-01", "router", {
      latestSnapshot: {
        battery: { temperatureCelsius: 31.5 },
        thermalZones: [],
      },
      receivedAt: "2026-08-18T00:09:59.000Z",
    });
    const systems: BoothSystemSnapshotEnvelope[] = [
      {
        boothId: "booth-01",
        snapshot: { temperatureCelsius: 49.75 },
        receivedAt: "2026-08-18T00:00:00.000Z",
      },
    ];

    const [summary] = buildFleetThermalSummaries(
      [router],
      systems,
      Date.parse("2026-08-18T00:10:00.000Z"),
    );

    expect(summary).toMatchObject({
      piCpuTemperatureCelsius: null,
      routerBatteryTemperatureCelsius: 31.5,
      offline: false,
    });
  });
});

describe("thermal chart shaping", () => {
  it("builds combined, CPU, battery, and one chart entry per thermal-zone series", () => {
    const history: ThermalHistory = {
      boothId: "booth-01",
      source: {
        boothId: "booth-01",
        componentId: "router",
        displayName: "Router",
        kind: "router",
        prometheusJob: "glinet-router",
        prometheusInstance: "router-01",
      },
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-18T00:00:00.000Z",
      stepSeconds: 60,
      series: [
        {
          metric: "booth_cpu_temperature_celsius",
          labels: { booth_id: "booth-01" },
          points: [{ timestamp: 1, value: 48 }],
        },
        {
          metric: "glinet_battery_temperature_celsius",
          labels: { instance: "router-01" },
          points: [{ timestamp: 1, value: 31 }],
        },
        {
          metric: "glinet_thermal_temperature_celsius",
          labels: { zone: "soc" },
          points: [{ timestamp: 1, value: 55 }],
        },
        {
          metric: "glinet_thermal_temperature_celsius",
          labels: { sensor: "wifi" },
          points: [{ timestamp: 1, value: 47 }],
        },
      ],
    };

    const charts = shapeThermalCharts(history);
    expect(charts.combined).toHaveLength(4);
    expect(charts.cpu.map((series) => series.label)).toEqual(["Pi CPU"]);
    expect(charts.battery.map((series) => series.label)).toEqual(["Router battery"]);
    expect(charts.zones.map((series) => series.label)).toEqual(["soc", "wifi"]);
  });

  it("encodes label tuples without delimiter collisions", () => {
    const history: ThermalHistory = {
      boothId: "booth-01",
      source: {
        boothId: "booth-01",
        componentId: "router",
        displayName: "Router",
        kind: "router",
        prometheusJob: "glinet-router",
        prometheusInstance: "router-01",
      },
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-18T00:00:00.000Z",
      stepSeconds: 60,
      series: [
        {
          metric: "glinet_thermal_temperature_celsius",
          labels: { a: "b,c=d" },
          points: [{ timestamp: 1, value: 50 }],
        },
        {
          metric: "glinet_thermal_temperature_celsius",
          labels: { a: "b", c: "d" },
          points: [{ timestamp: 1, value: 51 }],
        },
      ],
    };

    const ids = shapeThermalCharts(history).zones.map((series) => series.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
