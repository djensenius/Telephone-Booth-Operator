import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { RuntimeModeBadge } from "./RuntimeModeBadge.js";

describe("RuntimeModeBadge", () => {
  it("renders nothing for real or null modes", () => {
    const { container: nullContainer } = render(<RuntimeModeBadge mode={null} />);
    expect(nullContainer.firstChild).toBeNull();
    const { container: realContainer } = render(<RuntimeModeBadge mode="real" />);
    expect(realContainer.firstChild).toBeNull();
    const { container: undefContainer } = render(<RuntimeModeBadge mode={undefined} />);
    expect(undefContainer.firstChild).toBeNull();
  });

  it("renders a MOCK pill for mock mode", () => {
    render(<RuntimeModeBadge mode="mock" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toBe("MOCK");
    expect(badge.className).toContain("runtime-mode-badge--mock");
    expect(badge.getAttribute("data-mode")).toBe("mock");
  });

  it("renders a SIM pill for simulator mode", () => {
    render(<RuntimeModeBadge mode="simulator" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toBe("SIM");
    expect(badge.className).toContain("runtime-mode-badge--simulator");
    expect(badge.getAttribute("data-mode")).toBe("simulator");
  });

  it("propagates an extra className when supplied", () => {
    render(<RuntimeModeBadge mode="mock" className="custom-class" />);
    expect(screen.getByRole("status").className).toContain("custom-class");
  });

  it("omits the status role when nested inside another live region", () => {
    // Used by BoothStatusBadge, which is itself a role="status" container.
    // Nested live regions can cause screen readers to double-announce updates.
    render(<RuntimeModeBadge mode="mock" nested />);
    expect(screen.queryByRole("status")).toBeNull();
    const badge = screen.getByLabelText("Booth runtime mode: mock");
    expect(badge.textContent).toBe("MOCK");
  });
});
