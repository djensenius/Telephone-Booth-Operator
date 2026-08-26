import type { JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BoothStatusProvider } from "../components/booth/BoothStatusContext.js";
import { BoothStatusBadge } from "../components/booth/BoothStatusBadge.js";
import { apiQueryKeys } from "./api-client.js";
import type { StatusHistory } from "./api-client.js";
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderProvider(client: QueryClient = new QueryClient()): QueryClient {
  render(
    <QueryClientProvider client={client}>
      <BoothStatusProvider>
        <BoothWebSocketProvider enabled>
          <BoothEnvelopeBridge />
          <BoothStatusBadge />
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
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

    const status = {
      state: "recording",
      runtimeMode: "mock",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    act(() => socket.emit("message", { data: JSON.stringify(status) }));

    await waitFor(() =>
      expect(client.getQueryData(apiQueryKeys.status)).toMatchObject({ state: "recording" }),
    );
    expect(client.getQueryData(apiQueryKeys.statusHistory)).toMatchObject({
      items: [{ state: "recording" }],
    });
    expect(screen.getByText("Recording")).toBeDefined();
    expect(screen.getByText("MOCK")).toBeDefined();
  });

  it("keeps the app-wide badge current without mounting the status screen", async () => {
    vi.setSystemTime(new Date("2026-05-01T00:10:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            state: "idle",
            updatedAt: "2026-05-01T00:00:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          }),
        ),
      ),
    );

    renderProvider();
    expect(await screen.findByText("Booth offline")).toBeDefined();

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.emit("open"));
    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "recording",
            runtimeMode: "simulator",
            updatedAt: "2026-05-01T00:10:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );

    await waitFor(() => expect(screen.getByText("Recording")).toBeDefined());
    expect(screen.queryByText("Booth offline")).toBeNull();
    expect(screen.getByText("SIM")).toBeDefined();

    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "idle",
            updatedAt: "2026-05-01T00:05:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );

    expect(screen.getByText("Recording")).toBeDefined();
    expect(screen.getByText("SIM")).toBeDefined();
  });

  it("keeps REST reconciliation active while the status socket is live", async () => {
    let requestCount = 0;
    const pendingResponse = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn(() => {
      requestCount += 1;
      return requestCount === 1
        ? Promise.resolve(
            jsonResponse({
              state: "idle",
              updatedAt: new Date().toISOString(),
              isSynthetic: true,
            }),
          )
        : pendingResponse;
    });
    vi.stubGlobal("fetch", fetchMock);

    renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0]!.emit("open"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("clears the badge when REST reports no current status", async () => {
    let requestCount = 0;
    let resolveNoStatus: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          jsonResponse({
            state: "recording",
            runtimeMode: "simulator",
            updatedAt: new Date().toISOString(),
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          }),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveNoStatus = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = renderProvider();
    await waitFor(() => expect(screen.getByText("Recording")).toBeDefined());
    expect(screen.getByText("SIM")).toBeDefined();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0]!.emit("open"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const resolveCurrentStatus = resolveNoStatus;
    if (resolveCurrentStatus === undefined) throw new Error("Status reconciliation did not start.");
    await act(async () => {
      resolveCurrentStatus(
        jsonResponse({
          state: "idle",
          updatedAt: "1970-01-01T00:00:00.000Z",
          isSynthetic: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText("Idle")).toBeDefined());
    expect(screen.queryByText("SIM")).toBeNull();
    expect(client.getQueryData(apiQueryKeys.status)).toBeNull();
    expect(client.getQueryData(apiQueryKeys.statusHistory)).toEqual({ items: [] });
  });

  it("does not let a delayed status request overwrite a newer live frame", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = renderProvider();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.emit("open"));
    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "recording",
            updatedAt: "2026-05-01T00:10:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );

    expect(client.getQueryData(apiQueryKeys.status)).toMatchObject({ state: "recording" });
    const resolveStatusFetch = resolveFetch;
    if (resolveStatusFetch === undefined) throw new Error("Status request did not start.");
    await act(async () => {
      resolveStatusFetch(
        jsonResponse({
          state: "idle",
          updatedAt: "2026-05-01T00:05:00.000Z",
          currentQuestionId: null,
          currentMessageId: null,
          lastError: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.getQueryData(apiQueryKeys.status)).toMatchObject({
      state: "recording",
      updatedAt: "2026-05-01T00:10:00.000Z",
    });
    expect(screen.getByText("Recording")).toBeDefined();
  });

  it("does not let a delayed history request erase a live frame", async () => {
    let resolveHistory: ((history: StatusHistory) => void) | undefined;
    const client = new QueryClient();
    const historyRequest = client
      .fetchQuery({
        queryKey: apiQueryKeys.statusHistory,
        queryFn: () =>
          new Promise<StatusHistory>((resolve) => {
            resolveHistory = resolve;
          }),
      })
      .catch(() => undefined);

    renderProvider(client);
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.emit("open"));
    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "recording",
            updatedAt: "2026-05-01T00:10:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );

    expect(client.getQueryData(apiQueryKeys.statusHistory)).toMatchObject({
      items: [{ state: "recording", updatedAt: "2026-05-01T00:10:00.000Z" }],
    });
    const resolveStatusHistory = resolveHistory;
    if (resolveStatusHistory === undefined)
      throw new Error("Status history request did not start.");
    resolveStatusHistory({ items: [] });
    await historyRequest;

    expect(client.getQueryData(apiQueryKeys.statusHistory)).toMatchObject({
      items: [{ state: "recording", updatedAt: "2026-05-01T00:10:00.000Z" }],
    });
  });

  it("resets status ordering when the active installation changes", async () => {
    const client = renderProvider();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.emit("open"));
    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "recording",
            runtimeMode: "simulator",
            updatedAt: "2026-05-01T00:10:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );
    await waitFor(() => expect(screen.getByText("Recording")).toBeDefined());

    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "installation",
          installation: {
            id: "ee333333-3333-4333-8333-333333333333",
            name: "Fresh era",
            notes: null,
            location: null,
            startedAt: "2026-05-01T00:11:00.000Z",
            endedAt: null,
            endedById: null,
            summary: null,
            createdAt: "2026-05-01T00:11:00.000Z",
            isActive: true,
          },
        }),
      }),
    );

    expect(client.getQueryData(apiQueryKeys.status)).toBeUndefined();
    expect(client.getQueryData(apiQueryKeys.statusHistory)).toBeUndefined();
    expect(screen.getByText("Idle")).toBeDefined();
    expect(screen.queryByText("SIM")).toBeNull();

    act(() =>
      socket.emit("message", {
        data: JSON.stringify({
          kind: "status",
          status: {
            state: "playingQuestion",
            updatedAt: "2026-05-01T00:05:00.000Z",
            currentQuestionId: null,
            currentMessageId: null,
            lastError: null,
          },
        }),
      }),
    );

    await waitFor(() => expect(screen.getByText("Playing")).toBeDefined());
    expect(client.getQueryData(apiQueryKeys.status)).toMatchObject({
      state: "playingQuestion",
      updatedAt: "2026-05-01T00:05:00.000Z",
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
