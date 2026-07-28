import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  emptyDebugConnectionPrefs,
  forgetDebugConnectionPrefs,
  getDebugConnectionStorageKey,
  purgeLegacyDebugConnectionTokens,
  readDebugConnectionPrefs,
  writeDebugConnectionPrefs,
} from "../../lib/debug-client.js";
import { PhoneClientConnection } from "./PhoneClientConnection.js";

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

function installLocalStorage(): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}

describe("PhoneClientConnection", () => {
  beforeEach(() => {
    installLocalStorage();
    window.localStorage.clear();
    forgetDebugConnectionPrefs("user-123");
  });

  afterEach(() => {
    forgetDebugConnectionPrefs("user-123");
  });

  it("persists non-secret edits to user-scoped localStorage but keeps the token in memory", () => {
    render(<PhoneClientConnection userSub="user-123" />);

    fireEvent.change(screen.getByLabelText("Tailscale URL"), {
      target: { value: "https://tail.example" },
    });
    fireEvent.change(screen.getByLabelText("LAN URL"), {
      target: { value: "https://192.168.1.42:8443" },
    });
    fireEvent.change(screen.getByLabelText("Debug token"), { target: { value: "secret-token" } });

    const stored = window.localStorage.getItem(getDebugConnectionStorageKey("user-123"));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      tailscaleUrl: "https://tail.example",
      lanUrl: "https://192.168.1.42:8443",
    });
    // The bearer token must never be written to localStorage (XSS-exfiltratable).
    expect(parsed.token).toBeUndefined();
    // ...but it remains available in the in-memory store for the session.
    expect(readDebugConnectionPrefs("user-123").token).toBe("secret-token");
  });

  it("describes the token field with the memory-only hint", () => {
    render(<PhoneClientConnection userSub="user-123" />);

    const input = screen.getByLabelText("Debug token");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain("memory only");
  });

  it("forgets persisted connection settings and the in-memory token", () => {
    window.localStorage.setItem(
      getDebugConnectionStorageKey("user-123"),
      JSON.stringify({
        tailscaleUrl: "https://tail.example",
        lanUrl: "",
        pinnedFingerprint: "",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    render(<PhoneClientConnection userSub="user-123" />);

    fireEvent.change(screen.getByLabelText("Debug token"), { target: { value: "secret-token" } });
    expect(readDebugConnectionPrefs("user-123").token).toBe("secret-token");

    fireEvent.click(screen.getByText("Forget"));

    expect(window.localStorage.getItem(getDebugConnectionStorageKey("user-123"))).toBeNull();
    expect(readDebugConnectionPrefs("user-123").token).toBe("");
    expect(screen.getByLabelText("Tailscale URL")).toHaveProperty("value", "");
  });
});

describe("legacy debug token migration", () => {
  beforeEach(() => {
    installLocalStorage();
    window.localStorage.clear();
    forgetDebugConnectionPrefs("user-123");
    forgetDebugConnectionPrefs("user-456");
  });

  afterEach(() => {
    forgetDebugConnectionPrefs("user-123");
    forgetDebugConnectionPrefs("user-456");
  });

  function writeLegacyRecord(userSub: string, token: string): void {
    window.localStorage.setItem(
      getDebugConnectionStorageKey(userSub),
      JSON.stringify({
        tailscaleUrl: "https://tail.example",
        lanUrl: "https://192.168.1.42:8443",
        token,
        pinnedFingerprint: "ab:cd",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
  }

  it("rewrites every legacy record without the token but keeps the other prefs", () => {
    writeLegacyRecord("user-123", "legacy-secret");
    writeLegacyRecord("user-456", "other-secret");
    window.localStorage.setItem("unrelated.key", JSON.stringify({ token: "not-ours" }));

    purgeLegacyDebugConnectionTokens();

    for (const userSub of ["user-123", "user-456"]) {
      const raw = window.localStorage.getItem(getDebugConnectionStorageKey(userSub)) ?? "{}";
      expect(raw).not.toContain("secret");
      expect(JSON.parse(raw) as Record<string, unknown>).toEqual({
        tailscaleUrl: "https://tail.example",
        lanUrl: "https://192.168.1.42:8443",
        pinnedFingerprint: "ab:cd",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    // Records outside the debug-connection namespace are left alone.
    expect(window.localStorage.getItem("unrelated.key")).toContain("not-ours");
    // The legacy token is discarded rather than adopted into the session.
    expect(readDebugConnectionPrefs("user-123").token).toBe("");
  });

  it("drops records that are not parseable objects", () => {
    window.localStorage.setItem(getDebugConnectionStorageKey("user-123"), "{token: broken");
    window.localStorage.setItem(getDebugConnectionStorageKey("user-456"), '"legacy-secret"');

    purgeLegacyDebugConnectionTokens();

    expect(window.localStorage.getItem(getDebugConnectionStorageKey("user-123"))).toBeNull();
    expect(window.localStorage.getItem(getDebugConnectionStorageKey("user-456"))).toBeNull();
  });

  it("treats blocked localStorage as non-fatal", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage is blocked", "SecurityError");
      },
    });

    try {
      // The boot-time migration must never take the app down before React mounts.
      expect(() => {
        purgeLegacyDebugConnectionTokens();
      }).not.toThrow();
      expect(() => {
        writeDebugConnectionPrefs(
          { ...emptyDebugConnectionPrefs(), token: "secret-token" },
          "user-123",
        );
      }).not.toThrow();
      // The token still reaches the in-memory store even with no persistence.
      expect(readDebugConnectionPrefs("user-123").token).toBe("secret-token");
      expect(() => {
        forgetDebugConnectionPrefs("user-123");
      }).not.toThrow();
      expect(readDebugConnectionPrefs("user-123").token).toBe("");
    } finally {
      installLocalStorage();
    }
  });

  it("strips a legacy token lazily when prefs are read before the migration runs", () => {
    writeLegacyRecord("user-123", "legacy-secret");

    const prefs = readDebugConnectionPrefs("user-123");

    expect(prefs.token).toBe("");
    expect(prefs.tailscaleUrl).toBe("https://tail.example");
    expect(window.localStorage.getItem(getDebugConnectionStorageKey("user-123"))).not.toContain(
      "legacy-secret",
    );
  });
});
