import axe from "axe-core";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  BoothSystemSnapshotEnvelope,
  CurrentWeather,
  TelemetrySourceEnvelope,
  ThermalHistory,
} from "@telephone-booth-operator/shared";
import { BoothStatusProvider } from "../../components/booth/BoothStatusContext.js";
import { apiQueryKeys } from "../../lib/api-client.js";
import { TELEMETRY_FRESHNESS_WINDOW_MS } from "../../lib/telemetry-freshness.js";
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

const currentWeather: CurrentWeather = {
  boothId: "booth-01",
  source: "open_meteo",
  temperatureCelsius: 22.2,
  relativeHumidityPercent: 67,
  cloudCoverPercent: 12,
  condition: "clear_sky",
  observedAt: receivedAt,
  fetchedAt: receivedAt,
};

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

function renderScreen({
  sourceData = [secondSource, preferredSource],
  systemData = systems,
  historyData = history,
  weatherData = currentWeather,
}: {
  readonly sourceData?: readonly TelemetrySourceEnvelope[];
  readonly systemData?: readonly BoothSystemSnapshotEnvelope[];
  readonly historyData?: ThermalHistory;
  readonly weatherData?: CurrentWeather | null;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(apiQueryKeys.systemAll, { items: systemData });
  client.setQueryData(apiQueryKeys.systemComponents(), sourceData);
  const selectedSource =
    sourceData.find((source) => source.componentId === "router") ?? sourceData[0];
  if (selectedSource) {
    if (weatherData) {
      client.setQueryData(apiQueryKeys.currentWeather(selectedSource.boothId), weatherData);
    }
    client.setQueryData(
      apiQueryKeys.thermalHistory(selectedSource.boothId, selectedSource.componentId, "24h"),
      historyData,
    );
  }
  return Object.assign(
    render(
      <BoothStatusProvider>
        <QueryClientProvider client={client}>
          <ThermalsScreen />
        </QueryClientProvider>
      </BoothStatusProvider>,
    ),
    { client },
  );
}

function renderEmptyScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(apiQueryKeys.systemAll, { items: [] });
  client.setQueryData(apiQueryKeys.systemComponents(), []);
  return render(
    <BoothStatusProvider>
      <QueryClientProvider client={client}>
        <ThermalsScreen />
      </QueryClientProvider>
    </BoothStatusProvider>,
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
  client.setQueryData(apiQueryKeys.currentWeather(offlineSource.boothId), {
    ...currentWeather,
    boothId: offlineSource.boothId,
  });
  client.setQueryData(
    apiQueryKeys.thermalHistory(offlineSource.boothId, offlineSource.componentId, "24h"),
    offlineHistory,
  );
  return render(
    <BoothStatusProvider>
      <QueryClientProvider client={client}>
        <ThermalsScreen />
      </QueryClientProvider>
    </BoothStatusProvider>,
  );
}

describe("ThermalsScreen", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders fleet current cards, selected summaries, and shaped history charts", async () => {
    renderScreen();

    expect(screen.getByRole("heading", { name: "Thermals" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Booth and source" })).toBeDefined();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(1);
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("booth-01");
    expect(screen.getAllByText("48.3 °C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("31.5 °C").length).toBeGreaterThan(0);
    expect(screen.getAllByText("55.3 °C").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Current outdoor weather" })).toBeDefined();
    expect(screen.getByText("22.2 °C")).toBeDefined();
    expect(screen.getByText("67%")).toBeDefined();
    expect(screen.getByText("Clear sky")).toBeDefined();
    expect(screen.getByText("12%")).toBeDefined();
    expect(screen.getByText("Weather current")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Combined thermal history" })).toBeDefined();
    expect(screen.getByText("Pi CPU sensor")).toBeDefined();
    expect(screen.getByText("Router battery sensor")).toBeDefined();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "wifi" })).toBeNull();

    const zoneSummary = screen
      .getAllByText("wifi")
      .map((element) => element.closest("summary"))
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (!zoneSummary) throw new Error("missing collapsible Wi-Fi sensor");
    const details = zoneSummary.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(zoneSummary);
    expect(details?.open).toBe(true);
    expect(await screen.findByRole("heading", { name: "wifi" })).toBeDefined();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    fireEvent.click(zoneSummary);
    expect(details?.open).toBe(false);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "wifi" })).toBeNull());
    expect(screen.getAllByRole("img")).toHaveLength(1);
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

  it("keeps thermal data visible when the initial weather request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("weather unavailable")),
    );
    renderScreen({ weatherData: null });

    expect(await screen.findByText("Current outdoor weather is unavailable.")).toBeDefined();
    expect(screen.getAllByText("48.3 °C").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Combined thermal history" })).toBeDefined();
  });

  it("keeps cached weather and thermal data visible when a refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("weather unavailable")),
    );
    const rendered = renderScreen();

    await rendered.client.invalidateQueries({
      queryKey: apiQueryKeys.currentWeather(preferredSource.boothId),
    });

    expect(await screen.findByText(/latest refresh failed/)).toBeDefined();
    expect(screen.getByText("22.2 °C")).toBeDefined();
    expect(screen.getAllByText("48.3 °C").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Combined thermal history" })).toBeDefined();
  });

  it("transitions unchanged current data to offline as the freshness clock advances", () => {
    vi.useFakeTimers();
    onlineManager.setOnline(false);
    const nowMilliseconds = Date.parse("2026-08-18T00:05:00.000Z");
    vi.setSystemTime(nowMilliseconds);
    const sourceData: TelemetrySourceEnvelope[] = [
      {
        ...preferredSource,
        receivedAt: new Date(
          nowMilliseconds - TELEMETRY_FRESHNESS_WINDOW_MS + 15_000,
        ).toISOString(),
      },
    ];
    const systemData: BoothSystemSnapshotEnvelope[] = [
      {
        ...systems[0]!,
        receivedAt: new Date(nowMilliseconds).toISOString(),
      },
    ];
    const rendered = renderScreen({ sourceData, systemData });

    expect(screen.getByText("Telemetry current")).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("Telemetry offline")).toBeDefined();
    rendered.unmount();
  });

  it("has no critical accessibility violations", async () => {
    const { container } = renderScreen();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((violation) => violation.impact === "critical")).toHaveLength(
      0,
    );
  });
});
