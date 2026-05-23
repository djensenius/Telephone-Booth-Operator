import axe from "axe-core";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App.js";
import { createAppRouter } from "../../app/router.js";
import { getDebugConnectionStorageKey } from "../../lib/debug-client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class SilentWebSocket extends EventTarget {
  constructor(_url: string, _protocols?: string | string[]) {
    super();
  }
  send(_data: string): void {}
  close(): void {}
}

function installBrowserStubs(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
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
  window.scrollTo = vi.fn();
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
  vi.stubGlobal("WebSocket", SilentWebSocket);
}

function renderDebug(): void {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: ["/debug"] }) });
  render(<App router={router} />);
}

describe("DebugScreen", () => {
  beforeEach(() => {
    installBrowserStubs();
    window.localStorage.clear();
    window.localStorage.setItem(
      getDebugConnectionStorageKey(),
      JSON.stringify({ tailscaleUrl: "https://tail.example", lanUrl: "https://192.168.1.42:8443", token: "debug-token", pinnedFingerprint: "sha256:abc", updatedAt: "2026-01-01T00:00:00Z" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.endsWith("/v1/auth/me")) {
          return Promise.resolve(jsonResponse({ id: "user-1", email: "operator@example.com", name: "Jane Operator", groups: [], providerName: "Authentik" }));
        }
        if (url.endsWith("/v1/state")) {
          return Promise.resolve(jsonResponse({ state: "idle", updatedAt: "2026-01-01T00:00:00Z", currentQuestionId: null, currentMessageId: null, lastError: null }));
        }
        if (url.endsWith("/v1/gpio")) {
          return Promise.resolve(jsonResponse({ updatedAt: "2026-01-01T00:00:01Z", pins: [{ role: "hook", level: true, debouncedState: true, lastEdgeMonotonicNs: 12, lastEventId: 1 }] }));
        }
        if (url.endsWith("/v1/audio")) {
          return Promise.resolve(jsonResponse({ inputLevelDbfs: -24, outputLevelDbfs: -36, inputPeakDbfs: -12, outputPeakDbfs: -30, currentDevice: "USB handset", sampleRateHz: 48000, updatedAt: "2026-01-01T00:00:02Z" }));
        }
        if (url.includes("/v1/logs")) {
          return Promise.resolve(jsonResponse([{ ts: "2026-01-01T00:00:03Z", level: "info", target: "booth", message: "Line is ready" }]));
        }
        if (url.endsWith("/v1/config")) {
          return Promise.resolve(jsonResponse({ gpio: { hook: 17 }, audio: {}, operator: { token: "<redacted:oken>" }, debug: { allowControls: true } }));
        }
        if (url.endsWith("/v1/events")) {
          return Promise.resolve(jsonResponse([{ id: 2, ts: "2026-01-01T00:00:04Z", kind: "state_transition", from: "dial_tone", to: "idle", cause: "hook_on", at_monotonic_ns: 99 }]));
        }
        return Promise.resolve(jsonResponse({ ok: true, version: "test" }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders live diagnostic panels from the debug surface", async () => {
    renderDebug();

    expect(await screen.findByText("Debug")).toBeTruthy();
    expect((await screen.findAllByText("idle")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Pin 17")).toBeTruthy();
    expect(await screen.findByText("USB handset")).toBeTruthy();
    expect(await screen.findByText("Line is ready")).toBeTruthy();
    expect(await screen.findByText("Simulate hook-off")).toBeTruthy();
  });

  it("has no critical axe violations", async () => {
    const { container } = render(<App router={createAppRouter({ history: createMemoryHistory({ initialEntries: ["/debug"] }) })} />);
    await screen.findByText("Pin 17");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    const criticalViolations = results.violations.filter((violation) => violation.impact === "critical");
    expect(criticalViolations).toHaveLength(0);
  });
});
