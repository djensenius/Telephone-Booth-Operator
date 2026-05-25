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
    });
    expect(parsed.outcome).toBe("recording_completed");
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
    });
    expect(parsed.endedAt).toBeNull();
  });
});

describe("BoothSystemSnapshotSchema", () => {
  it("accepts the minimal required fields", () => {
    const parsed = BoothSystemSnapshotSchema.parse({
      boothId: "booth-01",
      capturedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(parsed.boothId).toBe("booth-01");
  });

  it("accepts a rich snapshot", () => {
    const parsed = BoothSystemSnapshotSchema.parse({
      boothId: "booth-01",
      capturedAt: "2026-06-01T00:00:00.000Z",
      uptimeSeconds: 3600,
      cpuTemperatureCelsius: 47.3,
      cpuUsageRatio: 0.21,
      loadAverage1m: 0.5,
      memoryUsedBytes: 100_000_000,
      memoryTotalBytes: 4_000_000_000,
      disks: [{ mountpoint: "/", totalBytes: 30_000_000_000, availableBytes: 20_000_000_000 }],
      networkInterfaces: [{ name: "eth0", receivedBytes: 1000, transmittedBytes: 2000 }],
      tailscaleConnected: true,
      throttlingFlags: [],
    });
    expect(parsed.disks?.[0]?.mountpoint).toBe("/");
  });

  it("tolerates unknown forward-compat fields via passthrough", () => {
    const parsed = BoothSystemSnapshotSchema.parse({
      boothId: "booth-01",
      capturedAt: "2026-06-01T00:00:00.000Z",
      futureField: 42,
    });
    expect((parsed as Record<string, unknown>).futureField).toBe(42);
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
      snapshot: {
        boothId: "booth-01",
        capturedAt: "2026-06-01T00:00:00.000Z",
      },
      receivedAt: "2026-06-01T00:00:01.000Z",
    });
    expect(parsed.kind).toBe("system");
  });

  it("rejects an unknown kind", () => {
    expect(() => WsEnvelopeSchema.parse({ kind: "weather", foo: 1 } as unknown)).toThrow();
  });
});
