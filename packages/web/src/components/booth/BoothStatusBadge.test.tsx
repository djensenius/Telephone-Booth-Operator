import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BoothStatusProvider } from "./BoothStatusContext.js";
import { BoothStatusBadge } from "./BoothStatusBadge.js";

describe("BoothStatusBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reflects booth status with a label and color class", () => {
    render(
      <BoothStatusProvider initialStatus="recording">
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    const badges = screen.getAllByRole("status");
    const outer = badges.find((el) => el.className.includes("booth-status-badge--recording"));
    expect(outer).toBeDefined();
    expect(screen.getByText("Booth status")).toBeDefined();
    expect(screen.getByText("Recording")).toBeDefined();
  });

  it("does not render a runtime-mode pill for the default real booth", () => {
    render(
      <BoothStatusProvider initialStatus="idle">
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.queryByText("MOCK")).toBeNull();
    expect(screen.queryByText("SIM")).toBeNull();
  });

  it("renders a SIM pill when the booth reports simulator mode", () => {
    render(
      <BoothStatusProvider initialStatus="idle" initialRuntimeMode="simulator">
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.getByText("SIM")).toBeDefined();
  });

  it("renders a MOCK pill when the booth reports mock mode", () => {
    render(
      <BoothStatusProvider initialStatus="idle" initialRuntimeMode="mock">
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.getByText("MOCK")).toBeDefined();
  });

  it("shows no staleness label when lastStatusAt is recent", () => {
    const now = new Date();
    render(
      <BoothStatusProvider initialStatus="idle" initialLastStatusAt={now}>
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.queryByText(/Last seen/u)).toBeNull();
    expect(screen.queryByText("Booth offline")).toBeNull();
  });

  it("shows warning staleness when lastStatusAt exceeds 60s", () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    render(
      <BoothStatusProvider initialStatus="idle" initialLastStatusAt={twoMinutesAgo}>
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.getByText("Last seen 2m ago")).toBeDefined();
    const badges = screen.getAllByRole("status");
    const outer = badges.find((el) => el.className.includes("booth-status-badge--stale-warning"));
    expect(outer).toBeDefined();
  });

  it("shows offline staleness when lastStatusAt exceeds 5 minutes", () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    render(
      <BoothStatusProvider initialStatus="idle" initialLastStatusAt={tenMinutesAgo}>
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.getByText("Booth offline")).toBeDefined();
    const badges = screen.getAllByRole("status");
    const outer = badges.find((el) => el.className.includes("booth-status-badge--stale-offline"));
    expect(outer).toBeDefined();
  });

  it("transitions from fresh to warning as time passes", () => {
    const now = new Date();
    render(
      <BoothStatusProvider initialStatus="idle" initialLastStatusAt={now}>
        <BoothStatusBadge />
      </BoothStatusProvider>,
    );
    expect(screen.queryByText(/Last seen/u)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(70_000);
    });

    expect(screen.getByText("Last seen 1m ago")).toBeDefined();
  });
});
