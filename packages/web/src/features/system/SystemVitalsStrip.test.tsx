import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  BoothSystemSnapshotEnvelope,
  TelemetrySourceEnvelope,
} from "@telephone-booth-operator/shared";
import { apiQueryKeys } from "../../lib/api-client.js";
import { TELEMETRY_FRESHNESS_WINDOW_MS } from "../../lib/telemetry-freshness.js";
import { SystemVitalsStrip } from "./SystemVitalsStrip.js";

function renderStrip(
  envelope?: BoothSystemSnapshotEnvelope,
  sources: readonly TelemetrySourceEnvelope[] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const boothId = envelope?.boothId ?? "booth-01";
  if (envelope) {
    client.setQueryData(apiQueryKeys.system(envelope.boothId), envelope);
  }
  client.setQueryData(apiQueryKeys.systemComponents(boothId), sources);
  return render(
    <QueryClientProvider client={client}>
      <SystemVitalsStrip boothId={boothId} />
    </QueryClientProvider>,
  );
}

const baseSnapshot = {
  cpu: {
    usageRatio: 0.23,
    perCoreUsageRatio: [0.2, 0.25, 0.21, 0.26],
    physicalCores: 4,
    loadAvg1m: 0.5,
    loadAvg5m: 0.4,
    loadAvg15m: 0.3,
  },
  temperatureCelsius: 48,
  memory: {
    totalBytes: 4_294_967_296,
    usedBytes: 1_073_741_824,
  },
  uptimeSeconds: 3 * 86_400 + 4 * 3_600 + 15 * 60,
  tailscale: { connected: true },
  runtimeMode: "real" as const,
};

const routerReceivedAt = new Date().toISOString();

const routerSource: TelemetrySourceEnvelope = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  boothId: "booth-01",
  componentId: "router",
  displayName: "Travel router",
  kind: "router",
  prometheusJob: "glinet-router",
  prometheusInstance: "router-01",
  latestSnapshot: {
    battery: { temperatureCelsius: 31.5 },
    thermalZones: [],
  },
  capturedAt: routerReceivedAt,
  receivedAt: routerReceivedAt,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: routerReceivedAt,
};

describe("SystemVitalsStrip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an awaiting-snapshot placeholder when nothing is cached", () => {
    renderStrip();
    expect(screen.getByText("Live vitals")).toBeDefined();
    expect(screen.getByText(/awaiting first snapshot|connecting/i)).toBeDefined();
    // Tiles still render so layout doesn't pop in once data arrives.
    expect(screen.getByText("CPU temp")).toBeDefined();
    expect(screen.getByText("Memory")).toBeDefined();
    expect(screen.getByText("Fan")).toBeDefined();
    expect(screen.getByText("Awaiting telemetry")).toBeDefined();
  });

  it("formats values with units once a snapshot is cached", () => {
    renderStrip(
      {
        boothId: "booth-01",
        snapshot: baseSnapshot,
        receivedAt: "2026-05-27T00:00:05.000Z",
      },
      [routerSource],
    );
    // CPU temp formatted to one decimal with the °C unit.
    expect(screen.getByText("48.0°C")).toBeDefined();
    // CPU usage rounded to whole percent.
    expect(screen.getByText("23%")).toBeDefined();
    // Memory percent (1 GiB / 4 GiB → 25.0%).
    expect(screen.getByText("25.0%")).toBeDefined();
    // Uptime in `Xd Yh Zm` form.
    expect(screen.getByText("3d 4h 15m")).toBeDefined();
    expect(screen.getByText("31.5°C")).toBeDefined();
  });

  it("keeps an explicit missing state when router battery temperature is absent", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const batteryTile = screen.getByText("Router battery").parentElement;
    expect(batteryTile?.textContent).toContain("—");
  });

  it("preserves router loading and error states without hiding host vitals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(apiQueryKeys.system("booth-01"), {
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    render(
      <QueryClientProvider client={client}>
        <SystemVitalsStrip boothId="booth-01" />
      </QueryClientProvider>,
    );

    expect(screen.getByText("…")).toBeDefined();
    expect(await screen.findByText("offline")).toBeDefined();
    expect(screen.getByText("48.0°C")).toBeDefined();
  });

  it("gives a background query error precedence over cached router temperature", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    client.setQueryData(apiQueryKeys.system("booth-01"), {
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: routerReceivedAt,
    });
    client.setQueryData(apiQueryKeys.systemComponents("booth-01"), [routerSource]);
    render(
      <QueryClientProvider client={client}>
        <SystemVitalsStrip boothId="booth-01" />
      </QueryClientProvider>,
    );
    expect(screen.getByText("31.5°C")).toBeDefined();

    const componentQuery = client.getQueryCache().find({
      queryKey: apiQueryKeys.systemComponents("booth-01"),
      exact: true,
    });
    if (!componentQuery) throw new Error("missing component query");
    act(() => {
      componentQuery.setState({
        ...componentQuery.state,
        error: new Error("unavailable"),
        errorUpdateCount: componentQuery.state.errorUpdateCount + 1,
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
        status: "error",
      });
    });

    await waitFor(() => expect(screen.getByText("offline")).toBeDefined());
    expect(screen.queryByText("31.5°C")).toBeNull();
  });

  it("marks cached router temperature offline after the source freshness window", () => {
    const staleSource: TelemetrySourceEnvelope = {
      ...routerSource,
      receivedAt: new Date(Date.now() - TELEMETRY_FRESHNESS_WINDOW_MS).toISOString(),
    };
    renderStrip(
      {
        boothId: "booth-01",
        snapshot: baseSnapshot,
        receivedAt: routerReceivedAt,
      },
      [staleSource],
    );

    const batteryTile = screen.getByText("Router battery").parentElement;
    expect(batteryTile?.textContent).toContain("offline");
    expect(batteryTile?.textContent).not.toContain("31.5°C");
  });

  it("renders fan PWM as a dial while prioritizing measured RPM", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        fan: {
          commandedOn: true,
          pwmRatio: 0.67,
          rpm: 4_250,
          coolingState: 2,
          maxCoolingState: 3,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    expect(
      screen.getByRole("group", { name: /4250 RPM measured, 67% PWM commanded/i }),
    ).toBeDefined();
    expect(screen.getByText("4,250")).toBeDefined();
    expect(screen.getByText("RPM · 67%")).toBeDefined();
  });

  it("labels commanded fan speed when tachometer feedback is unavailable", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        fan: {
          commandedOn: true,
          pwmRatio: 0.34,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    expect(screen.getByText("34%")).toBeDefined();
    expect(screen.getByText("PWM · no tach")).toBeDefined();
  });

  it("does not invent zero PWM when only an off command is reported", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        fan: {
          commandedOn: false,
          rpm: 900,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    expect(screen.getByText("900")).toBeDefined();
    expect(screen.getByText("RPM · Off")).toBeDefined();
    expect(screen.queryByText(/0% PWM/i)).toBeNull();
    expect(screen.getByRole("group", { name: /fan commanded off/i })).toBeDefined();
  });

  it("flags CPU temperature severity when it crosses warn/crit thresholds", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: { ...baseSnapshot, temperatureCelsius: 78 },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const tile = screen.getByText("78.0°C").parentElement;
    expect(tile?.className).toContain("system-vitals-strip__tile--crit");
  });

  it("surfaces Tailscale outages with a critical tile", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: { ...baseSnapshot, tailscale: { connected: false } },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const tile = screen.getByText("down").parentElement;
    expect(tile?.className).toContain("system-vitals-strip__tile--crit");
  });

  it("shows throttling flags only when one is asserted", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        throttling: {
          undervoltage: true,
          armFreqCapped: false,
          throttled: false,
          softTempLimit: false,
          undervoltageOccurred: false,
          throttledOccurred: false,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    expect(screen.getByText("Throttling")).toBeDefined();
  });

  it("hides the throttling tile when every flag is false", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        throttling: {
          undervoltage: false,
          armFreqCapped: false,
          throttled: false,
          softTempLimit: false,
          undervoltageOccurred: false,
          throttledOccurred: false,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    expect(screen.queryByText("Throttling")).toBeNull();
  });

  it("links to the dedicated live-system page so the strip stays clickable", () => {
    renderStrip();
    const link = screen.getByRole("link", { name: /details/i });
    expect(link.getAttribute("href")).toBe("/system");
  });
});
