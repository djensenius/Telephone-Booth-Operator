import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import { apiQueryKeys } from "../../lib/api-client.js";
import { SystemVitalsStrip } from "./SystemVitalsStrip.js";

function renderStrip(envelope?: BoothSystemSnapshotEnvelope) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (envelope) {
    client.setQueryData(apiQueryKeys.system(envelope.boothId), envelope);
  }
  return render(
    <QueryClientProvider client={client}>
      <SystemVitalsStrip boothId={envelope?.boothId ?? "booth-01"} />
    </QueryClientProvider>,
  );
}

const baseSnapshot = {
  boothId: "booth-01",
  capturedAt: "2026-05-27T00:00:00.000Z",
  cpuTemperatureCelsius: 48,
  cpuUsageRatio: 0.23,
  cpuUsageRatioPerCore: [0.2, 0.25, 0.21, 0.26],
  loadAverage1m: 0.5,
  loadAverage5m: 0.4,
  loadAverage15m: 0.3,
  memoryUsedBytes: 1_073_741_824,
  memoryTotalBytes: 4_294_967_296,
  uptimeSeconds: 3 * 86_400 + 4 * 3_600 + 15 * 60,
  tailscaleConnected: true,
  throttlingFlags: [],
  runtimeMode: "real" as const,
};

describe("SystemVitalsStrip", () => {
  it("renders an awaiting-snapshot placeholder when nothing is cached", () => {
    renderStrip();
    expect(screen.getByText("Live vitals")).toBeDefined();
    expect(screen.getByText(/awaiting first snapshot|connecting/i)).toBeDefined();
    // Tiles still render so layout doesn't pop in once data arrives.
    expect(screen.getByText("CPU temp")).toBeDefined();
    expect(screen.getByText("Memory")).toBeDefined();
  });

  it("formats values with units once a snapshot is cached", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: baseSnapshot,
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    // CPU temp formatted to one decimal with the °C unit.
    expect(screen.getByText("48.0°C")).toBeDefined();
    // CPU usage rounded to whole percent.
    expect(screen.getByText("23%")).toBeDefined();
    // Memory percent (1 GiB / 4 GiB → 25.0%).
    expect(screen.getByText("25.0%")).toBeDefined();
    // Uptime in `Xd Yh Zm` form.
    expect(screen.getByText("3d 4h 15m")).toBeDefined();
  });

  it("flags CPU temperature severity when it crosses warn/crit thresholds", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: { ...baseSnapshot, cpuTemperatureCelsius: 78 },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const tile = screen.getByText("78.0°C").parentElement;
    expect(tile?.className).toContain("system-vitals-strip__tile--crit");
  });

  it("surfaces Tailscale outages with a critical tile", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: { ...baseSnapshot, tailscaleConnected: false },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    const tile = screen.getByText("down").parentElement;
    expect(tile?.className).toContain("system-vitals-strip__tile--crit");
  });

  it("shows throttling flags only when present", () => {
    renderStrip({
      boothId: "booth-01",
      snapshot: { ...baseSnapshot, throttlingFlags: ["under-voltage"] },
      receivedAt: "2026-05-27T00:00:05.000Z",
    });
    expect(screen.getByText("Throttling")).toBeDefined();
  });

  it("links to the dedicated live-system page so the strip stays clickable", () => {
    renderStrip();
    const link = screen.getByRole("link", { name: /details/i });
    expect(link.getAttribute("href")).toBe("/system");
  });
});
