import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BoothStatusProvider } from "../components/booth/BoothStatusContext.js";
import { BoothWebSocketProvider, useBoothWebSocket } from "./booth-websocket.js";

// Minimal stand-in: enough of the WebSocket surface for the provider, with the
// lifecycle driven by the test rather than a server.
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

function Probe(): JSX.Element {
  const ws = useBoothWebSocket();
  return <span data-testid="ws-state">{ws.state}</span>;
}

function renderProvider(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BoothStatusProvider>
        <BoothWebSocketProvider enabled>
          <Probe />
        </BoothWebSocketProvider>
      </BoothStatusProvider>
    </QueryClientProvider>,
  );
}

describe("BoothWebSocketProvider", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A socket that errors is closed and replaced once. Its own `close` arrives
  // afterwards, and acting on that late event would open a second connection
  // in parallel with the live one, duplicating every envelope.
  it("replaces a failed socket exactly once", async () => {
    renderProvider();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const first = FakeSocket.instances[0]!;

    act(() => first.emit("error"));
    expect(first.closed).toBe(true);
    act(() => first.emit("close"));

    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));

    // The replacement is live; the corpse speaking up again changes nothing.
    act(() => FakeSocket.instances[1]!.emit("open"));
    act(() => first.emit("close"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeSocket.instances).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("ws-state").textContent).toBe("live"));
  });
});
