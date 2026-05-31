import { describe, expect, it } from "vite-plus/test";
import {
  BoothNetworkStatsSchema,
  BoothStatusSchema,
  QuestionSchema,
  QuestionStatusSchema,
} from "../src/index.js";

describe("BoothStatusSchema", () => {
  it("accepts a valid status", () => {
    const parsed = BoothStatusSchema.parse({
      state: "idle",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.state).toBe("idle");
  });

  it("rejects an unknown state", () => {
    expect(() =>
      BoothStatusSchema.parse({
        state: "nope",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("BoothNetworkStatsSchema", () => {
  it("parses and preserves IPv4/IPv6 addresses", () => {
    const parsed = BoothNetworkStatsSchema.parse({
      interface: "eth0",
      receiveBytesTotal: 1024,
      transmitBytesTotal: 2048,
      addresses: ["192.168.1.42", "fe80::1"],
    });
    expect(parsed.addresses).toEqual(["192.168.1.42", "fe80::1"]);
  });

  it("treats addresses as optional", () => {
    const parsed = BoothNetworkStatsSchema.parse({
      interface: "eth0",
      receiveBytesTotal: 0,
      transmitBytesTotal: 0,
    });
    expect(parsed.addresses).toBeUndefined();
  });

  it("rejects non-string address entries", () => {
    expect(() =>
      BoothNetworkStatsSchema.parse({
        interface: "eth0",
        receiveBytesTotal: 0,
        transmitBytesTotal: 0,
        addresses: ["192.168.1.42", 1234],
      }),
    ).toThrow();
  });
});

describe("QuestionStatusSchema", () => {
  it("accepts the draft/active/archived lifecycle states", () => {
    expect(QuestionStatusSchema.parse("draft")).toBe("draft");
    expect(QuestionStatusSchema.parse("active")).toBe("active");
    expect(QuestionStatusSchema.parse("archived")).toBe("archived");
  });

  it("rejects unknown states", () => {
    expect(() => QuestionStatusSchema.parse("retired")).toThrow();
  });

  it("requires status on a Question payload", () => {
    const question = {
      id: "11111111-1111-1111-1111-111111111111",
      prompt: "What did the booth ask?",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      audio: {
        url: "https://example.com/a.flac",
        sha256: "a".repeat(64),
        durationMs: 1234,
      },
    };
    expect(QuestionSchema.parse(question).status).toBe("active");
    const { status: _status, ...withoutStatus } = question;
    expect(() => QuestionSchema.parse(withoutStatus)).toThrow();
  });
});
