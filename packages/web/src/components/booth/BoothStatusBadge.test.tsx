import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { BoothStatusProvider } from "./BoothStatusContext.js";
import { BoothStatusBadge } from "./BoothStatusBadge.js";

describe("BoothStatusBadge", () => {
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
});
