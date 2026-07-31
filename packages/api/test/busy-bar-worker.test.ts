import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const socketMocks = vi.hoisted(() => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly url: string;
    readonly options: unknown;
    readyState = FakeWebSocket.OPEN;
    readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      sockets.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.#listeners.get(event) ?? [];
      listeners.push(listener);
      this.#listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) listener(...args);
    }

    close(code = 1000): void {
      this.readyState = 3;
      this.emit("close", code);
    }
  }

  const sockets: FakeWebSocket[] = [];
  return { FakeWebSocket, sockets };
});

vi.mock("ws", () => ({ WebSocket: socketMocks.FakeWebSocket }));

import type { BoothStatus, BoothSystemSnapshotEnvelope } from "@telephone-booth-operator/shared";
import {
  readInitialStatus,
  startOperatorPolling,
  startOperatorStream,
  type BusyBarOperatorMonitor,
} from "../src/busy-bar-worker.js";

const status = (id = 1): BoothStatus => ({
  id,
  state: "idle",
  updatedAt: "2026-07-31T20:00:00.000Z",
  currentQuestionId: null,
  currentMessageId: null,
  lastError: null,
  runtimeMode: "real",
});

const system = (boothId: string): BoothSystemSnapshotEnvelope => ({
  boothId,
  snapshot: { temperatureCelsius: 45 },
  receivedAt: "2026-07-31T20:00:00.000Z",
  version: "0.3.2",
});

const monitor = (): BusyBarOperatorMonitor & {
  updateStatus: ReturnType<typeof vi.fn>;
  updateSystem: ReturnType<typeof vi.fn>;
} => ({
  updateStatus: vi.fn(),
  updateSystem: vi.fn(),
});

describe("BUSY Bar operator feed", () => {
  beforeEach(() => {
    socketMocks.sockets.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("treats the synthetic default status as missing", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          state: "idle",
          updatedAt: "2026-07-31T20:00:00.000Z",
          currentQuestionId: null,
          currentMessageId: null,
          lastError: null,
          runtimeMode: null,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(readInitialStatus("https://operator.example.com", "token")).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json(status()));
    await expect(readInitialStatus("https://operator.example.com", "token")).resolves.toMatchObject(
      {
        id: 1,
      },
    );
  });

  it("polls persisted state and stops cleanly", async () => {
    const currentMonitor = monitor();
    const fetchMock = vi.fn((input: string | URL) => {
      const url = new URL(input.toString());
      return Promise.resolve(
        url.pathname === "/v1/status"
          ? Response.json(status())
          : Response.json(system(url.searchParams.get("boothId") ?? "")),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const feed = startOperatorPolling(
      "https://operator.example.com",
      "token",
      "booth-01",
      currentMonitor,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(currentMonitor.updateStatus).toHaveBeenCalledTimes(1);
    expect(currentMonitor.updateSystem).toHaveBeenCalledWith(
      expect.objectContaining({ boothId: "booth-01" }),
    );
    expect(
      fetchMock.mock.calls.some(([input]) => input.toString().includes("boothId=booth-01")),
    ).toBe(true);

    feed.stop();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("filters other booths, reconnects, and stops", async () => {
    const currentMonitor = monitor();
    const feed = startOperatorStream(
      "https://operator.example.com",
      "token",
      "booth-01",
      currentMonitor,
    );
    const first = socketMocks.sockets[0];
    expect(first).toBeDefined();

    first?.emit("message", Buffer.from(JSON.stringify({ kind: "system", ...system("booth-02") })));
    first?.emit("message", Buffer.from(JSON.stringify({ kind: "system", ...system("booth-01") })));
    first?.emit("message", Buffer.from(JSON.stringify({ kind: "status", status: status() })));
    expect(currentMonitor.updateSystem).toHaveBeenCalledTimes(1);
    expect(currentMonitor.updateStatus).toHaveBeenCalledTimes(1);

    first?.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socketMocks.sockets).toHaveLength(2);

    feed.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socketMocks.sockets).toHaveLength(2);
  });
});
