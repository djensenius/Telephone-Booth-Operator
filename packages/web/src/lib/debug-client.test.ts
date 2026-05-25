import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDebugClient } from "./debug-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

describe("debug client", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fails over from Tailscale to LAN after two failures", async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url.startsWith("https://tail.example")) {
        return Promise.reject(new Error("tail down"));
      }
      return Promise.resolve(
        jsonResponse({
          state: "idle",
          updatedAt: "2026-01-01T00:00:00Z",
          currentQuestionId: null,
          currentMessageId: null,
          lastError: null,
        }),
      );
    });
    const client = createDebugClient({
      tailscaleUrl: "https://tail.example",
      lanUrl: "https://192.168.1.42:8443",
      fetchImpl,
    });

    await expect(client.getState()).rejects.toThrow("tail down");
    await expect(client.getState()).resolves.toMatchObject({ state: "idle" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls[2]?.[0] === undefined ? "" : requestUrl(fetchImpl.mock.calls[2][0]),
    ).toBe("https://192.168.1.42:8443/v1/state");
  });

  it("does not throw on malformed JSON WebSocket frames", () => {
    const client = createDebugClient({
      tailscaleUrl: "https://tail.example",
      webSocketFactory: FakeWebSocket as unknown as typeof WebSocket,
    });

    const events: unknown[] = [];
    const unsubscribe = client.subscribe((record) => events.push(record));
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatchEvent(new Event("open"));

    // Non-JSON string — should not throw
    ws.dispatchEvent(new MessageEvent("message", { data: "not json at all" }));
    expect(events).toHaveLength(0);

    // Truncated JSON — should not throw
    ws.dispatchEvent(new MessageEvent("message", { data: '{"id":1,"ts":"2026' }));
    expect(events).toHaveLength(0);

    // Valid JSON but wrong shape — parseJsonRecord returns null, no crash
    ws.dispatchEvent(new MessageEvent("message", { data: '{"foo":"bar"}' }));
    expect(events).toHaveLength(0);

    unsubscribe();
  });

  it("emits lastError on malformed telemetry frames", () => {
    const changes: Array<{ lastError?: string }> = [];
    const client = createDebugClient({
      tailscaleUrl: "https://tail.example",
      webSocketFactory: FakeWebSocket as unknown as typeof WebSocket,
      onConnectionChanged: (change) => changes.push(change),
    });

    const unsubscribe = client.subscribe(vi.fn());
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatchEvent(new Event("open"));

    ws.dispatchEvent(new MessageEvent("message", { data: "{{bad json" }));
    const errorChange = changes.find((c) => c.lastError !== undefined);
    expect(errorChange?.lastError).toBe("Malformed telemetry frame (invalid JSON)");

    unsubscribe();
  });

  it("still delivers valid telemetry records after a malformed frame", () => {
    const client = createDebugClient({
      tailscaleUrl: "https://tail.example",
      webSocketFactory: FakeWebSocket as unknown as typeof WebSocket,
    });

    const events: unknown[] = [];
    const unsubscribe = client.subscribe((record) => events.push(record));
    const ws = FakeWebSocket.instances[0]!;
    ws.dispatchEvent(new Event("open"));

    // Bad frame first
    ws.dispatchEvent(new MessageEvent("message", { data: "garbage" }));

    // Then a valid record
    const validRecord = JSON.stringify({
      id: 42,
      ts: "2026-01-01T00:00:00Z",
      kind: "state_transition",
      from: "idle",
      to: "ringing",
      cause: "hook_off",
      at_monotonic_ns: 100,
    });
    ws.dispatchEvent(new MessageEvent("message", { data: validRecord }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 42, kind: "state_transition" });

    unsubscribe();
  });

  it("reconnects telemetry WebSocket with capped exponential backoff", () => {
    vi.useFakeTimers();
    const client = createDebugClient({
      tailscaleUrl: "https://tail.example",
      webSocketFactory: FakeWebSocket as unknown as typeof WebSocket,
    });

    const unsubscribe = client.subscribe(vi.fn());
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.close();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]?.close();
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    unsubscribe();
  });
});
