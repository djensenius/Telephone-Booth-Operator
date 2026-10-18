import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type {
  BoothShellyStats,
  BoothSystemSnapshotEnvelope,
} from "@telephone-booth-operator/shared";
import { apiQueryKeys } from "../../lib/api-client.js";
import { BoothStatusProvider } from "../../components/booth/BoothStatusContext.js";
import { LiveSystemPanel } from "./LiveSystemPanel.js";

function renderPanel(envelope?: BoothSystemSnapshotEnvelope) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (envelope) {
    client.setQueryData(apiQueryKeys.system(envelope.boothId), envelope);
  }
  return render(
    <QueryClientProvider client={client}>
      <LiveSystemPanel boothId={envelope?.boothId ?? "booth-01"} />
    </QueryClientProvider>,
  );
}

// Captured-from-the-wire snapshot used by every test below. Mirrors the
// canonical nested shape the Rust `booth-hal::SystemSnapshot` serialises to.
const baseSnapshot = {
  cpu: {
    usageRatio: 0.42,
    perCoreUsageRatio: [0.4, 0.45, 0.4, 0.43],
    physicalCores: 4,
    loadAvg1m: 0.5,
    loadAvg5m: 0.4,
    loadAvg15m: 0.3,
  },
  temperatureCelsius: 57.9,
  memory: {
    totalBytes: 4_294_967_296,
    usedBytes: 1_073_741_824,
    swapTotalBytes: 2_147_483_648,
    swapUsedBytes: 0,
  },
  disks: [
    {
      mountPoint: "/",
      filesystem: "ext4",
      totalBytes: 125_553_487_872,
      availableBytes: 115_447_066_624,
    },
  ],
  networks: [
    {
      interface: "eth0",
      receiveBytesTotal: 7_205_631,
      transmitBytesTotal: 8_177_440,
      addresses: ["192.168.1.42", "fe80::1"],
    },
  ],
  uptimeSeconds: 3 * 86_400 + 4 * 3_600 + 15 * 60,
  process: {
    residentBytes: 14_426_112,
    virtualBytes: 922_062_848,
    uptimeSeconds: 5,
  },
  audio: { sampleRateHz: 48_000 },
  tailscale: { connected: true, hostname: "telephone-booth" },
  fan: {
    commandedOn: true,
    pwmRatio: 0.67,
    rpm: 4_250,
    coolingState: 2,
    maxCoolingState: 3,
  },
  runtimeMode: "real" as const,
};

function shellyHeatMat(overrides: Partial<BoothShellyStats> = {}): BoothShellyStats {
  return {
    device: "vivosun-heat-mat",
    endpoint: "switch:0",
    outputOn: true,
    powerWatts: 47.2,
    voltageVolts: 121.1,
    frequencyHertz: 60,
    currentAmperes: 0.39,
    energyWattHours: 1234.5,
    temperatureCelsius: 28.4,
    fetchedAtUnixSeconds: 1_780_000_000,
    ...overrides,
  };
}

describe("LiveSystemPanel", () => {
  it("shows expected downtime without hiding a real system error", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(apiQueryKeys.status, {
      state: "idle",
      updatedAt: "1970-01-01T00:00:00.000Z",
      isSynthetic: true,
      installationState: "between_exhibitions",
    });
    client.setQueryData(apiQueryKeys.system("booth-01"), null);
    render(
      <QueryClientProvider client={client}>
        <BoothStatusProvider>
          <LiveSystemPanel boothId="booth-01" />
        </BoothStatusProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Between exhibitions")).toBeDefined();
    expect(screen.getByText(/No live booth telemetry is expected/)).toBeDefined();
    const query = client
      .getQueryCache()
      .find({ queryKey: apiQueryKeys.system("booth-01"), exact: true });
    if (!query) throw new Error("missing system query");
    act(() => query.setState({ status: "error", error: new Error("system unavailable") }));
    await waitFor(() =>
      expect(screen.getByText("Could not read the booth's vitals.")).toBeDefined(),
    );
    expect(screen.queryByText(/No live booth telemetry is expected/)).toBeNull();
  });

  it("renders the booth client version when provided in the envelope", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
      version: "0.3.2",
    });
    // The "Phone client version" row is the first row in the grid.
    expect(screen.getByText("Phone client version")).toBeDefined();
    expect(screen.getByText("0.3.2")).toBeDefined();
  });

  it("falls back to em-dash when the envelope omits the version", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const versionRow = screen.getByText("Phone client version").closest("div");
    expect(versionRow).toBeDefined();
    expect(within(versionRow!).getByText("—")).toBeDefined();
  });

  it("renders the loading state when the cache has no snapshot yet", () => {
    renderPanel();
    expect(screen.getByText("Live system")).toBeDefined();
    // Without a cached snapshot the panel shows the skeleton + connecting copy
    // until the first PUT lands.
    expect(screen.getByText(/Connecting/i)).toBeDefined();
    expect(screen.getByText(/Reading the meters/i)).toBeDefined();
  });

  it("maps every nested snapshot field into the detail grid", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    // CPU temperature + percent usage come from nested `temperatureCelsius`
    // and `cpu.usageRatio` respectively.
    expect(screen.getByText("57.9 °C")).toBeDefined();
    expect(screen.getByText("42%")).toBeDefined();

    // Load averages read from `cpu.loadAvg{1,5,15}m`.
    expect(screen.getByText("0.50")).toBeDefined();
    expect(screen.getByText("0.40")).toBeDefined();
    expect(screen.getByText("0.30")).toBeDefined();

    // Uptime is formatted Xd Yh Zm from `uptimeSeconds`.
    expect(screen.getByText("3d 4h 15m")).toBeDefined();

    // Audio sample rate hangs off the nested `audio` object.
    expect(screen.getByText("48000 Hz")).toBeDefined();

    // Tailscale shows hostname when connected.
    expect(screen.getByText("up (telephone-booth)")).toBeDefined();

    // Commanded fan state remains distinct from measured tachometer speed.
    expect(screen.getByText("on (67% PWM)")).toBeDefined();
    expect(screen.getByText("2 / 3")).toBeDefined();
    expect(screen.getByText("4250 RPM")).toBeDefined();
  });

  it("shows fan command without implying measured rotation when tachometer data is absent", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        fan: {
          commandedOn: true,
          pwmRatio: 0.34,
          coolingState: 1,
          maxCoolingState: 3,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    expect(screen.getByText("on (34% PWM)")).toBeDefined();
    const measuredSpeedRow = screen.getByText("Fan measured speed").parentElement;
    expect(within(measuredSpeedRow!).getByText("— (no tachometer)")).toBeDefined();
  });

  it("shows PWM telemetry when commanded state is absent", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        fan: {
          pwmRatio: 0.67,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    expect(screen.getByText("67% PWM")).toBeDefined();
  });

  it("renders Shelly heat mat relay state and current power draw", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        shelly: [shellyHeatMat()],
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    const heatMatRow = screen.getByText("Shelly / Vivosun heat mat").parentElement;
    expect(heatMatRow).toBeDefined();
    expect(heatMatRow!.textContent).toContain("vivosun-heat-mat");
    expect(heatMatRow!.textContent).toContain("relay on");
    expect(heatMatRow!.textContent).toContain("heating / drawing power (47.2 W)");
    expect(heatMatRow!.textContent).toContain("current 0.39 A");
    expect(heatMatRow!.textContent).toContain("voltage 121.1 V");
  });

  it("keeps relay-on separate from no heater draw", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        shelly: [shellyHeatMat({ outputOn: true, powerWatts: 0 })],
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    const heatMatRow = screen.getByText("Shelly / Vivosun heat mat").parentElement;
    expect(heatMatRow).toBeDefined();
    expect(heatMatRow!.textContent).toContain("relay on");
    expect(heatMatRow!.textContent).toContain("heater off / no draw (0.0 W)");
  });

  it("keeps relay-off separate from no heater draw", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        shelly: [shellyHeatMat({ outputOn: false, powerWatts: 0 })],
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    const heatMatRow = screen.getByText("Shelly / Vivosun heat mat").parentElement;
    expect(heatMatRow).toBeDefined();
    expect(heatMatRow!.textContent).toContain("relay off");
    expect(heatMatRow!.textContent).toContain("heater off / no draw (0.0 W)");
  });

  it("renders an unavailable fetched marker for out-of-range Shelly timestamps", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        shelly: [shellyHeatMat({ fetchedAtUnixSeconds: Number.MAX_SAFE_INTEGER })],
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });

    const heatMatRow = screen.getByText("Shelly / Vivosun heat mat").parentElement;
    expect(heatMatRow).toBeDefined();
    expect(heatMatRow!.textContent).toContain("fetched —");
  });

  it("renders disk entries from snapshot.disks with mountPoint and filesystem", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const disksRow = screen.getByText("Disks").parentElement;
    expect(disksRow).toBeDefined();
    expect(within(disksRow!).getByText("/")).toBeDefined();
    expect(within(disksRow!).getByText(/ext4/)).toBeDefined();
  });

  it("renders network interfaces from snapshot.networks", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const netRow = screen.getByText("Network").parentElement;
    expect(netRow).toBeDefined();
    expect(within(netRow!).getByText("eth0")).toBeDefined();
    expect(within(netRow!).getByText(/192\.168\.1\.42/)).toBeDefined();
  });

  it("summarises throttling flags from the nested throttling object", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        ...baseSnapshot,
        throttling: {
          undervoltage: true,
          armFreqCapped: false,
          throttled: true,
          softTempLimit: false,
          undervoltageOccurred: true,
          throttledOccurred: false,
        },
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    expect(screen.getByText("under-voltage, throttled, under-voltage-occurred")).toBeDefined();
  });

  it("renders 'none' when throttling is present but every flag is false", () => {
    renderPanel({
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
    expect(screen.getByText("none")).toBeDefined();
  });

  it("falls back to em-dashes when sub-objects are absent", () => {
    renderPanel({
      boothId: "booth-01",
      snapshot: {
        runtimeMode: "real",
      },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    // CPU temperature + usage rows should both fall back to "—" without
    // throwing on missing `cpu` / `temperatureCelsius`.
    const cpuTempRow = screen.getByText("CPU temperature").parentElement;
    expect(within(cpuTempRow!).getByText("—")).toBeDefined();
    const cpuUsageRow = screen.getByText("CPU usage").parentElement;
    expect(within(cpuUsageRow!).getByText("—")).toBeDefined();
    // Throttling row falls back to "—" when the field is missing entirely.
    const throttlingRow = screen.getByText("Throttling").parentElement;
    expect(within(throttlingRow!).getByText("—")).toBeDefined();
  });
});
