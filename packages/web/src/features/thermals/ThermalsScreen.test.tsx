import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type {
  BoothSystemSnapshotEnvelope,
  TelemetrySourceEnvelope,
  ThermalHistory,
} from "@telephone-booth-operator/shared";
import { apiQueryKeys } from "../../lib/api-client.js";
import { ThermalsScreen } from "./ThermalsScreen.js";

const receivedAt = new Date().toISOString();

const preferredSource: TelemetrySourceEnvelope = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  boothId: "booth-01",
  componentId: "router",
  displayName: "Travel router",
  kind: "router",
  prometheusJob: "glinet-router",
  prometheusInstance: "router-01",
  latestSnapshot: {
    battery: { temperatureCelsius: 31.5 },
    thermalZones: [
      { name: "soc", temperatureCelsius: 55.25 },
      { name: "wifi", temperatureCelsius: 47.5 },
    ],
  },
  capturedAt: receivedAt,
  receivedAt,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: receivedAt,
};

const secondSource: TelemetrySourceEnvelope = {
  ...preferredSource,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  boothId: "booth-02",
  componentId: "router-02",
  displayName: "Backup router",
  prometheusInstance: "router-02",
  latestSnapshot: {
    battery: { temperatureCelsius: 29 },
    thermalZones: [{ name: "soc", temperatureCelsius: 51 }],
  },
};

const systems: BoothSystemSnapshotEnvelope[] = [
  {
    boothId: "booth-01",
    snapshot: { temperatureCelsius: 48.25 },
    receivedAt,
  },
  {
    boothId: "booth-02",
    snapshot: { temperatureCelsius: 46 },
    receivedAt,
  },
];

const history: ThermalHistory = {
  boothId: "booth-01",
  source: {
    boothId: preferredSource.boothId,
    componentId: preferredSource.componentId,
    displayName: preferredSource.displayName,
    kind: preferredSource.kind,
    prometheusJob: preferredSource.prometheusJob,
    prometheusInstance: preferredSource.prometheusInstance,
  },
  from: "2026-08-17T00:00:00.000Z",
  to: "2026-08-18T00:00:00.000Z",
  stepSeconds: 60,
  series: [
    {
      metric: "booth_cpu_temperature_celsius",
      labels: { booth_id: "booth-01" },
      points: [
        { timestamp: 1_776_556_800, value: 47 },
        { timestamp: 1_776_643_200, value: 48.25 },
      ],
    },
    {
      metric: "glinet_battery_temperature_celsius",
      labels: { job: "glinet-router", instance: "router-01" },
      points: [
        { timestamp: 1_776_556_800, value: 30 },
        { timestamp: 1_776_643_200, value: 31.5 },
      ],
    },
    {
      metric: "glinet_thermal_temperature_celsius",
      labels: { job: "glinet-router", instance: "router-01", zone: "soc" },
      points: [
        { timestamp: 1_776_556_800, value: 52 },
        { timestamp: 1_776_643_200, value: 55.25 },
      ],
    },
    {
      metric: "glinet_thermal_temperature_celsius",
      labels: { job: "glinet-router", instance: "router-01", zone: "wifi" },
      points: [
        { timestamp: 1_776_556_800, value: 45 },
        { timestamp: 1_776_643_200, value: 47.5 },
      ],
    },
  ],
};

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(apiQueryKeys.systemAll, { items: systems });
  client.setQueryData(apiQueryKeys.systemComponents(), [secondSource, preferredSource]);
  client.setQueryData(
    apiQueryKeys.thermalHistory(preferredSource.boothId, preferredSource.componentId, "24h"),
    history,
  );
  return render(
    <QueryClientProvider client={client}>
      <ThermalsScreen />
    </QueryClientProvider>,
  );
}

function renderEmptyScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(apiQueryKeys.systemAll, { items: [] });
  client.setQueryData(apiQueryKeys.systemComponents(), []);
  return render(
    <QueryClientProvider client={client}>
      <ThermalsScreen />
    </QueryClientProvider>,
  );
}

function renderOfflineScreen() {
  const offlineSource: TelemetrySourceEnvelope = {
    ...preferredSource,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    receivedAt: "2026-08-01T00:00:00.000Z",
    capturedAt: "2026-08-01T00:00:00.000Z",
  };
  const offlineHistory: ThermalHistory = {
    ...history,
    source: {
      ...history.source,
      componentId: offlineSource.componentId,
      displayName: offlineSource.displayName,
      prometheusInstance: offlineSource.prometheusInstance,
    },
    series: [],
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(apiQueryKeys.systemAll, { items: [] });
  client.setQueryData(apiQueryKeys.systemComponents(), [offlineSource]);
  client.setQueryData(
    apiQueryKeys.thermalHistory(offlineSource.boothId, offlineSource.componentId, "24h"),
    offlineHistory,
  );
  return render(
    <QueryClientProvider client={client}>
      <ThermalsScreen />
    </QueryClientProvider>,
  );
}

describe("ThermalsScreen", () => {
  it("renders fleet current cards, selected summaries, and shaped history charts", () => {
    renderScreen();

    expect(screen.getByRole("heading", { name: "Thermals" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Booth and source" })).toBeDefined();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(1);
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("booth-01");
    expect(screen.getAllByText("48.3 °C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("31.5 °C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("55.3 °C").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Combined thermal history" })).toBeDefined();
    expect(screen.getByText("Pi CPU sensor")).toBeDefined();
    expect(screen.getByText("Router battery sensor")).toBeDefined();

    const zoneSummary = screen
      .getAllByText("wifi")
      .map((element) => element.closest("summary"))
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (!zoneSummary) throw new Error("missing collapsible Wi-Fi sensor");
    const details = zoneSummary.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(zoneSummary);
    expect(details?.open).toBe(true);
  });

  it("renders a stable empty state before any router source exists", () => {
    renderEmptyScreen();
    expect(screen.getByText("No router telemetry sources")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Combined thermal history" })).toBeNull();
  });

  it("marks stale fleet telemetry offline while retaining history controls", () => {
    renderOfflineScreen();
    expect(screen.getByText("Telemetry offline")).toBeDefined();
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Combined thermal history" })).toBeDefined();
  });

  it("has no critical accessibility violations", async () => {
    const { container } = renderScreen();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((violation) => violation.impact === "critical")).toHaveLength(
      0,
    );
  });
});
