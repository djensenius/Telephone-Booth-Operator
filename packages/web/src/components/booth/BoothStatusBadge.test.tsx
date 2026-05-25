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
    expect(screen.getByRole("status").className).toContain("booth-status-badge--recording");
    expect(screen.getByText("Booth status")).toBeDefined();
    expect(screen.getByText("Recording")).toBeDefined();
  });
});
