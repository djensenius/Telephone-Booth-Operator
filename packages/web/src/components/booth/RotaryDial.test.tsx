import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App.js";
import { createAppRouter } from "../../app/router.js";

function installMatchMedia(reduceMotion: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: reduceMotion && query === "(prefers-reduced-motion: reduce)",
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

function renderAppAt(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} />);
  return router;
}

describe("RotaryDial", () => {
  beforeEach(() => {
    installMatchMedia(false);
    window.scrollTo = vi.fn();
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("clicking digit 1 navigates to /status", async () => {
    const router = renderAppAt("/about");
    const dialOne = await screen.findAllByRole("button", { name: "Dial 1 — Status" });
    fireEvent.click(dialOne[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/status"));
  });

  it("respects disabled state", async () => {
    const router = renderAppAt("/about");
    const dialSeven = await screen.findAllByRole("button", { name: "Dial 7 — Reserved" });
    expect(dialSeven[0]?.hasAttribute("disabled")).toBe(true);
    expect(router.state.location.pathname).toBe("/about");
  });

  it("renders static when reduced motion is requested", async () => {
    installMatchMedia(true);
    const { container } = render(<App router={createAppRouter({ history: createMemoryHistory({ initialEntries: ["/status"] }) })} />);
    await screen.findByText("Live status");
    expect(container.querySelector(".rotary-dial--reduced")).not.toBeNull();
  });

  it("numeric keyboard shortcut navigates", async () => {
    const router = renderAppAt("/about");
    await screen.findByText("About");
    fireEvent.keyDown(document, { key: "1" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/status"));
  });
});
