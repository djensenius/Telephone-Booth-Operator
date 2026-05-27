import { describe, expect, it } from "vite-plus/test";

import {
  BOOTH_EVENT_BATCH_MAX,
  BoothEventBatchSchema,
  BoothEventSchema,
  BoothSystemSnapshotSchema,
  CallOutcomeSchema,
  CallSessionSchema,
  WsEnvelopeSchema,
} from "../src/index.js";

const validEvent = {
  eventId: "11111111-1111-1111-1111-111111111111:42",
  boothId: "booth-01",
  bootId: "11111111-1111-1111-1111-111111111111",
  type: "call_started" as const,
  occurredAt: "2026-06-01T00:00:00.000Z",
  sessionId: "22222222-2222-2222-2222-222222222222",
  payload: { foo: "bar" },
};

describe("BoothEventSchema", () => {
  it("accepts a complete event", () => {
    expect(BoothEventSchema.parse(validEvent).type).toBe("call_started");
  });

  it("accepts an event with no payload, sessionId, or recordingId", () => {
    const { sessionId: _sessionId, payload: _payload, ...minimal } = validEvent;
    expect(() => BoothEventSchema.parse(minimal)).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => BoothEventSchema.parse({ ...validEvent, type: "made_up_event" })).toThrow();
  });

  it("rejects a non-UUID bootId", () => {
    expect(() => BoothEventSchema.parse({ ...validEvent, bootId: "nope" })).toThrow();
  });

  it("accepts string recordingIds (not @db.Uuid)", () => {
    const parsed = BoothEventSchema.parse({
      ...validEvent,
      type: "recording_started",
      recordingId: "recording-12345",
    });
    expect(parsed.recordingId).toBe("recording-12345");
  });
});

describe("BoothEventBatchSchema", () => {
  it("accepts a batch of events", () => {
    const parsed = BoothEventBatchSchema.parse({
      events: [validEvent, { ...validEvent, eventId: "evt-2" }],
    });
    expect(parsed.events).toHaveLength(2);
  });

  it("rejects an empty batch", () => {
    expect(() => BoothEventBatchSchema.parse({ events: [] })).toThrow();
  });

  it("rejects a batch larger than BOOTH_EVENT_BATCH_MAX", () => {
    const events = Array.from({ length: BOOTH_EVENT_BATCH_MAX + 1 }, (_, i) => ({
      ...validEvent,
      eventId: `evt-${i}`,
    }));
    expect(() => BoothEventBatchSchema.parse({ events })).toThrow();
  });
});

describe("CallOutcomeSchema", () => {
  it("accepts every documented outcome", () => {
    for (const outcome of [
      "hung_up_before_dial",
      "hung_up_during_prompt",
      "hung_up_during_recording",
      "hung_up_during_upload",
      "recording_completed",
      "recording_failed",
      "upload_failed",
      "operator_error",
      "aborted",
    ]) {
      expect(() => CallOutcomeSchema.parse(outcome)).not.toThrow();
    }
  });
});

describe("CallSessionSchema", () => {
  it("accepts a closed session", () => {
    const parsed = CallSessionSchema.parse({
      id: "33333333-3333-3333-3333-333333333333",
      boothId: "booth-01",
      bootId: "11111111-1111-1111-1111-111111111111",
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T00:01:00.000Z",
      digitsDialed: "1",
      outcome: "recording_completed",
      recordingId: "recording-1",
      durationMs: 60000,
      version: "0.3.2",
    });
    expect(parsed.outcome).toBe("recording_completed");
    expect(parsed.version).toBe("0.3.2");
  });

  it("accepts a live (un-ended) session", () => {
    const parsed = CallSessionSchema.parse({
      id: "33333333-3333-3333-3333-333333333333",
      boothId: "booth-01",
      bootId: "11111111-1111-1111-1111-111111111111",
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: null,
      digitsDialed: null,
      outcome: null,
      recordingId: null,
      durationMs: null,
      version: null,
    });
    expect(parsed.endedAt).toBeNull();
    expect(parsed.version).toBeNull();
  });
});

describe("BoothSystemSnapshotSchema", () => {
  it("accepts an empty snapshot (everything optional, forward-compat)", () => {
    const parsed = BoothSystemSnapshotSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a rich nested snapshot mirroring the Rust wire format", () => {
    const parsed = BoothSystemSnapshotSchema.parse({
      cpu: {
        usageRatio: 0.21,
        perCoreUsageRatio: [0.2, 0.22, 0.21, 0.2],
        physicalCores: 4,
        loadAvg1m: 0.5,
        loadAvg5m: 0.4,
        loadAvg15m: 0.3,
      },
      temperatureCelsius: 47.3,
      memory: {
        totalBytes: 4_000_000_000,
        usedBytes: 100_000_000,
        swapTotalBytes: 2_000_000_000,
        swapUsedBytes: 0,
      },
      disks: [
        {
          mountPoint: "/",
          filesystem: "ext4",
          totalBytes: 30_000_000_000,
          availableBytes: 20_000_000_000,
        },
      ],
      networks: [{ interface: "eth0", receiveBytesTotal: 1000, transmitBytesTotal: 2000 }],
      uptimeSeconds: 3600,
      process: { residentBytes: 14_426_112, virtualBytes: 922_062_848, uptimeSeconds: 5 },
      audio: { inputDevice: "USB Audio", outputDevice: "USB Audio" },
      tailscale: { connected: true, hostname: "telephone-booth" },
      throttling: {
        undervoltage: false,
        armFreqCapped: false,
        throttled: false,
        softTempLimit: false,
        undervoltageOccurred: false,
        throttledOccurred: false,
      },
      runtimeMode: "real" as const,
    });
    expect(parsed.disks?.[0]?.mountPoint).toBe("/");
    expect(parsed.networks?.[0]?.interface).toBe("eth0");
    expect(parsed.cpu?.physicalCores).toBe(4);
    expect(parsed.throttling?.undervoltage).toBe(false);
  });

  it("tolerates unknown forward-compat fields via passthrough", () => {
    const parsed = BoothSystemSnapshotSchema.parse({
      futureField: 42,
      cpu: { usageRatio: 0.1, unknownCpuField: "ok" },
    });
    expect((parsed as Record<string, unknown>).futureField).toBe(42);
    expect((parsed.cpu as Record<string, unknown> | undefined)?.unknownCpuField).toBe("ok");
  });

  it("rejects disk entries missing mountPoint", () => {
    expect(() =>
      BoothSystemSnapshotSchema.parse({
        disks: [{ totalBytes: 1, availableBytes: 1 }],
      }),
    ).toThrow();
  });

  it("rejects throttling supplied as a string array (old wire format)", () => {
    expect(() => BoothSystemSnapshotSchema.parse({ throttling: ["under-voltage"] })).toThrow();
  });
});

describe("WsEnvelopeSchema", () => {
  it("accepts a status envelope", () => {
    const parsed = WsEnvelopeSchema.parse({
      kind: "status",
      status: { state: "idle", updatedAt: "2026-06-01T00:00:00.000Z" },
    });
    expect(parsed.kind).toBe("status");
  });

  it("accepts a system envelope", () => {
    const parsed = WsEnvelopeSchema.parse({
      kind: "system",
      boothId: "booth-01",
      snapshot: { temperatureCelsius: 48 },
      receivedAt: "2026-06-01T00:00:01.000Z",
    });
    expect(parsed.kind).toBe("system");
  });

  it("rejects an unknown kind", () => {
    expect(() => WsEnvelopeSchema.parse({ kind: "weather", foo: 1 } as unknown)).toThrow();
  });
});
