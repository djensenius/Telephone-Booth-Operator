import { describe, expect, it, vi } from "vite-plus/test";
import { Broadcaster } from "../src/lib/broadcaster.js";

vi.mock("../src/lib/logger.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("Broadcaster", () => {
  it("delivers events to all subscribers", () => {
    const broadcaster = new Broadcaster<string>();
    const received: string[] = [];
    broadcaster.subscribe("a", (e) => received.push(`a:${e}`));
    broadcaster.subscribe("b", (e) => received.push(`b:${e}`));

    broadcaster.broadcast("hello");

    expect(received).toEqual(["a:hello", "b:hello"]);
  });

  it("continues delivering to remaining subscribers when one throws", () => {
    const broadcaster = new Broadcaster<string>();
    const received: string[] = [];

    broadcaster.subscribe("good-1", (e) => received.push(`1:${e}`));
    broadcaster.subscribe("bad", () => {
      throw new Error("boom");
    });
    broadcaster.subscribe("good-2", (e) => received.push(`2:${e}`));

    broadcaster.broadcast("test");

    expect(received).toContain("1:test");
    expect(received).toContain("2:test");
  });

  it("unsubscribes the throwing subscriber", () => {
    const broadcaster = new Broadcaster<string>();

    broadcaster.subscribe("bad", () => {
      throw new Error("boom");
    });
    broadcaster.subscribe("good", () => {});

    broadcaster.broadcast("first");
    expect(broadcaster.size).toBe(1);

    // Second broadcast should not invoke the removed subscriber
    const received: string[] = [];
    broadcaster.subscribe("new", (e) => received.push(e));
    broadcaster.broadcast("second");
    expect(received).toEqual(["second"]);
  });

  it("logs a warning when a subscriber throws", async () => {
    const { log } = await import("../src/lib/logger.js");
    const broadcaster = new Broadcaster<string>();

    broadcaster.subscribe("bad", () => {
      throw new Error("oops");
    });

    broadcaster.broadcast("x");

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "bad" }),
      "subscriber callback threw; unsubscribed",
    );
  });
});
