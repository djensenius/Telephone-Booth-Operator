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
    const { container } = renderShell();
    await screen.findByText("Status");
    expect(container.firstChild).toMatchSnapshot();
  });

  it("shows the build date in the app shell", async () => {
    renderShell();
    await screen.findByText("Status");
    expect(screen.getByText("Build date")).toBeTruthy();
    expect(screen.getByText("Jan 1, 1970, 12:00 AM")).toBeTruthy();
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
