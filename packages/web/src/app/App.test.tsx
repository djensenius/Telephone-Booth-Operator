import axe from "axe-core";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createAppRouter } from "./router.js";

function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderShell(path = "/status") {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<App router={router} />);
}

describe("App shell", () => {
  beforeEach(() => {
    installMatchMedia();
    window.scrollTo = vi.fn();
    Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => null),
    });
  });

  it("matches the themed shell snapshot", async () => {
    const { container } = renderShell();
    await screen.findByText("Live status");
    expect(container.firstChild).toMatchSnapshot();
  });

  it("has no critical axe violations", async () => {
    const { container } = renderShell();
    await screen.findByText("Live status");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    const criticalViolations = results.violations.filter((violation) => violation.impact === "critical");
    expect(criticalViolations).toHaveLength(0);
  });
});
