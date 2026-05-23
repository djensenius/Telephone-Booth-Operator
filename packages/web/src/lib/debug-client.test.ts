import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      return Promise.resolve(jsonResponse({ state: "idle", updatedAt: "2026-01-01T00:00:00Z", currentQuestionId: null, currentMessageId: null, lastError: null }));
    });
    const client = createDebugClient({ tailscaleUrl: "https://tail.example", lanUrl: "https://192.168.1.42:8443", fetchImpl });

    await expect(client.getState()).rejects.toThrow("tail down");
    await expect(client.getState()).resolves.toMatchObject({ state: "idle" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[0] === undefined ? "" : requestUrl(fetchImpl.mock.calls[2][0])).toBe("https://192.168.1.42:8443/v1/state");
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
