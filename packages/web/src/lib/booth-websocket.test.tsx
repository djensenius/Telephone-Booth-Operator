import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BoothStatusProvider } from "../components/booth/BoothStatusContext.js";
import { apiQueryKeys } from "./api-client.js";
import {
  BoothEnvelopeBridge,
  BoothWebSocketProvider,
  useBoothWebSocket,
} from "./booth-websocket.js";

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

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function Probe(): JSX.Element {
  const ws = useBoothWebSocket();
  return <span data-testid="ws-state">{ws.state}</span>;
}

function renderProvider(client: QueryClient = new QueryClient()): QueryClient {
  render(
    <QueryClientProvider client={client}>
      <BoothStatusProvider>
        <BoothWebSocketProvider enabled>
          <BoothEnvelopeBridge />
          <Probe />
        </BoothWebSocketProvider>
      </BoothStatusProvider>
    </QueryClientProvider>,
  );
  return client;
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

  // An older API build sends a bare status frame instead of the envelope. The
  // bridge is what keeps the cache current on every route, so it has to accept
  // that shape too — otherwise a console anywhere but the status screen goes
  // quiet against that build.
  it("writes a legacy bare status frame into the cache", async () => {
    const client = renderProvider();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.emit("open"));

    const status = { state: "idle", updatedAt: "2026-05-01T00:00:00.000Z" };
    act(() => socket.emit("message", { data: JSON.stringify(status) }));

    await waitFor(() =>
      expect(client.getQueryData(apiQueryKeys.status)).toMatchObject({ state: "idle" }),
    );
    expect(client.getQueryData(apiQueryKeys.statusHistory)).toMatchObject({
      items: [{ state: "idle" }],
    });
  });

  // A malformed URL makes the constructor throw rather than fire `error`, and
  // an unhandled throw in the effect would leave the provider with no socket
  // and no retry armed.
  it("retries when the socket constructor throws", async () => {
    let throwNext = true;
    vi.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor(url: string) {
          super(url);
          if (throwNext) {
            throwNext = false;
            FakeSocket.instances.pop();
            throw new SyntaxError("bad url");
          }
        }
      },
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("ws-state").textContent).toBe("polling"));

    await vi.advanceTimersByTimeAsync(2_000);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  });
});
