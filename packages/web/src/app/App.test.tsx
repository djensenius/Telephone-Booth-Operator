import axe from "axe-core";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App } from "./App.js";
import { createAppRouter } from "./router.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(options: { readonly authenticated?: boolean } = {}): void {
  const authenticated = options.authenticated ?? true;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.endsWith("/v1/auth/me"))
        return Promise.resolve(
          authenticated
            ? jsonResponse({
                id: "user-1",
                email: "operator@example.com",
                name: "Jane Operator",
                groups: [],
                providerName: "Authentik",
              })
            : new Response(JSON.stringify({ error: "unauthenticated" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
              }),
        );
      if (url.endsWith("/v1/status/history?limit=50"))
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                state: "idle",
                updatedAt: "2026-01-01T00:00:00.000Z",
                currentQuestionId: null,
                currentMessageId: null,
                lastError: null,
              },
            ],
          }),
        );
      if (url.endsWith("/v1/status"))
        return Promise.resolve(
          jsonResponse({
            state: "idle",
            updatedAt: "2026-01-01T00:00:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          }),
        );
      if (url.endsWith("/v1/system/current"))
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      return Promise.resolve(jsonResponse({ ok: true }));
    }),
  );
}

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
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("matches the themed shell snapshot", async () => {
    // Pin wall clock to match the mock /v1/status updatedAt so the booth-status
    // staleness computation is deterministic regardless of whether the status
    // query resolves before the snapshot is captured.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    try {
      const { container } = renderShell();
      await screen.findByText("Status");

      // The following DOM regions transition between several visual states
      // depending on how many in-flight fetch/WS microtasks have resolved by
      // the time the snapshot is captured (CPU- and scheduler-dependent).
      // Replace each with a stable placeholder so the snapshot is asserting
      // on app-shell structure rather than on async timing.
      const timeEl = container.querySelector(".build-footer time");
      const originalText = timeEl?.textContent;
      if (timeEl) timeEl.textContent = "{{BUILD_DATE}}";

      const lineDdAll = Array.from(container.querySelectorAll("dl dd"));
      const restoreLineText: Array<[Element, string | null]> = [];
      for (const dd of lineDdAll) {
        const text = dd.textContent ?? "";
        if (text === "connecting" || text === "polling" || text === "disconnected") {
          restoreLineText.push([dd, dd.textContent]);
          dd.textContent = "{{LINE_TRANSPORT}}";
        }
      }

      const busyAside = container.querySelector(".line-busy-placard");
      const busyOriginalClass = busyAside?.getAttribute("class") ?? null;
      const busyOriginalAriaHidden = busyAside?.getAttribute("aria-hidden") ?? null;
      if (busyAside) {
        busyAside.setAttribute("class", "line-busy-placard");
        busyAside.setAttribute("aria-hidden", "true");
      }

      const vitalsFooter = container.querySelector(".system-vitals-strip__footer");
      const vitalsOriginalClass = vitalsFooter?.getAttribute("class") ?? null;
      const vitalsOriginalText = vitalsFooter?.textContent ?? null;
      if (vitalsFooter) {
        vitalsFooter.setAttribute(
          "class",
          "system-vitals-strip__footer system-vitals-strip__footer--muted",
        );
        vitalsFooter.textContent = "{{VITALS_STATE}}";
      }

      expect(container.firstChild).toMatchSnapshot();

      if (timeEl) timeEl.textContent = originalText ?? "";
      for (const [dd, original] of restoreLineText) dd.textContent = original ?? "";
      if (busyAside && busyOriginalClass !== null) busyAside.setAttribute("class", busyOriginalClass);
      if (busyAside && busyOriginalAriaHidden !== null)
        busyAside.setAttribute("aria-hidden", busyOriginalAriaHidden);
      if (vitalsFooter && vitalsOriginalClass !== null)
        vitalsFooter.setAttribute("class", vitalsOriginalClass);
      if (vitalsFooter && vitalsOriginalText !== null) vitalsFooter.textContent = vitalsOriginalText;
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the build date in the app shell", async () => {
    renderShell();
    await screen.findByText("Status");
    expect(screen.getByText("Build date")).toBeTruthy();
    const timeEl = document.querySelector("time[datetime]");
    expect(timeEl).toBeTruthy();
    expect(timeEl!.getAttribute("datetime")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("hides operator status and shortcut navigation before login", async () => {
    installFetch({ authenticated: false });
    const { container } = renderShell("/");
    await screen.findByRole("heading", { name: "Sign in to connect" });
    expect(container.querySelector(".app-shell--public")).toBeTruthy();
    expect(screen.queryByText("Booth status")).toBeNull();
    expect(screen.queryByText("Shortcuts")).toBeNull();
    expect(screen.queryByLabelText("Operator navigation")).toBeNull();
  });

  it("submits shortcut 7 as logout instead of navigating to login", async () => {
    renderShell();
    const button = await screen.findByRole("button", { name: "7 · Logout" });
    const form = button.closest("form");
    if (!form) throw new Error("missing logout form");
    expect(form).toMatchObject({
      method: "post",
      action: "http://localhost/v1/auth/logout",
    });

    fireEvent.submit(form);
    expect(screen.getByRole("button", { name: "Clearing the line…" })).toBeTruthy();
  });

  it("has no critical axe violations", async () => {
    const { container } = renderShell();
    await screen.findByText("Status");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    const criticalViolations = results.violations.filter(
      (violation) => violation.impact === "critical",
    );
    expect(criticalViolations).toHaveLength(0);
  });
});
