import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getDebugConnectionStorageKey } from "../../lib/debug-client.js";
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
  });

  it("persists edits to user-scoped localStorage", () => {
    render(<PhoneClientConnection userSub="user-123" />);

    fireEvent.change(screen.getByLabelText("Tailscale URL"), { target: { value: "https://tail.example" } });
    fireEvent.change(screen.getByLabelText("LAN URL"), { target: { value: "https://192.168.1.42:8443" } });
    fireEvent.change(screen.getByLabelText("Debug token"), { target: { value: "secret-token" } });

    const stored = window.localStorage.getItem(getDebugConnectionStorageKey("user-123"));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "{}")).toMatchObject({
      tailscaleUrl: "https://tail.example",
      lanUrl: "https://192.168.1.42:8443",
      token: "secret-token",
    });
  });

  it("forgets persisted connection settings", () => {
    window.localStorage.setItem(getDebugConnectionStorageKey("user-123"), JSON.stringify({ tailscaleUrl: "https://tail.example", lanUrl: "", token: "", pinnedFingerprint: "", updatedAt: "2026-01-01T00:00:00Z" }));
    render(<PhoneClientConnection userSub="user-123" />);

    fireEvent.click(screen.getByText("Forget"));

    expect(window.localStorage.getItem(getDebugConnectionStorageKey("user-123"))).toBeNull();
    expect(screen.getByLabelText("Tailscale URL")).toHaveProperty("value", "");
  });
});
