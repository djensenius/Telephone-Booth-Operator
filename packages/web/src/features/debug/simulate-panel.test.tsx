import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CoreEvent, DebugClient } from "../../lib/debug-client.js";
import { SimulatePanel } from "./SimulatePanel.js";

function makeClient() {
  const simulateEvent = vi
    .fn<(event: CoreEvent) => Promise<{ readonly accepted: boolean; readonly injected: number }>>()
    .mockResolvedValue({ accepted: true, injected: 1 });
  const simulatePulse = vi
    .fn<(count: number) => Promise<{ readonly accepted: boolean; readonly injected: number }>>()
    .mockResolvedValue({ accepted: true, injected: 2 });
  const client: DebugClient = {
    getHealth: vi.fn(),
    getState: vi.fn(),
    getEvents: vi.fn(),
    getGpio: vi.fn(),
    getAudio: vi.fn(),
    getLogs: vi.fn(),
    getConfig: vi.fn(),
    getLanCertificateFingerprint: vi.fn(),
    simulateEvent,
    simulatePulse,
    subscribe: vi.fn(),
  };
  return { client, simulateEvent, simulatePulse };
}

describe("SimulatePanel", () => {
  it("is hidden when controls are disabled", () => {
    const { client } = makeClient();
    render(<SimulatePanel allowControls={false} client={client} />);
    expect(screen.queryByText("Simulate hook-off")).toBeNull();
  });

  it("posts the correct simulation commands", () => {
    const { client, simulateEvent, simulatePulse } = makeClient();
    render(<SimulatePanel allowControls client={client} />);

    fireEvent.click(screen.getByText("Simulate hook-off"));
    fireEvent.click(screen.getByText("Pulse 0"));
    fireEvent.click(screen.getByText("Simulate playback complete"));
    fireEvent.click(screen.getByText("Reset to Idle"));

    expect(simulateEvent).toHaveBeenNthCalledWith(1, { event: "hook_off" });
    expect(simulatePulse).toHaveBeenCalledWith(10);
    expect(simulateEvent).toHaveBeenNthCalledWith(2, { event: "playback_ended" });
    expect(simulateEvent).toHaveBeenNthCalledWith(3, { event: "hook_on" });
  });
});
