import { describe, expect, it } from "vite-plus/test";
import {
  BoothNetworkStatsSchema,
  BoothStatusSchema,
  CallSessionSchema,
  CreateApiTokenRequestSchema,
  InstructionSchema,
  InstructionStatusSchema,
  InstructionUpdateSchema,
  QuestionSchema,
  QuestionStatusSchema,
  RouterComponentSnapshotSchema,
} from "../src/index.js";

describe("BoothStatusSchema", () => {
  it("accepts a valid status", () => {
    const parsed = BoothStatusSchema.parse({
      state: "idle",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.state).toBe("idle");
  });

  it("accepts callUnavailable", () => {
    const parsed = BoothStatusSchema.parse({
      state: "callUnavailable",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.state).toBe("callUnavailable");
  });

  it("accepts the explicit synthetic-status marker", () => {
    const parsed = BoothStatusSchema.parse({
      state: "idle",
      updatedAt: "1970-01-01T00:00:00.000Z",
      isSynthetic: true,
    });
    expect(parsed.isSynthetic).toBe(true);
  });

  describe("InstructionStatusSchema", () => {
    it("accepts the active/inactive lifecycle states", () => {
      expect(InstructionStatusSchema.parse("active")).toBe("active");
      expect(InstructionStatusSchema.parse("inactive")).toBe("inactive");
    });

    it("requires status on an Instruction payload", () => {
      const instruction = {
        id: "11111111-1111-1111-1111-111111111111",
        description: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        audio: {
          url: "https://example.com/a.flac",
          sha256: "a".repeat(64),
          durationMs: 1234,
        },
      };
      expect(InstructionSchema.parse(instruction).status).toBe("active");
      const { status: _status, ...withoutStatus } = instruction;
      expect(() => InstructionSchema.parse(withoutStatus)).toThrow();
    });

    it("accepts description edits and clearing", () => {
      expect(InstructionUpdateSchema.parse({ description: "Updated" })).toEqual({
        description: "Updated",
      });
      expect(InstructionUpdateSchema.parse({ description: null })).toEqual({
        description: null,
      });
      expect(() => InstructionUpdateSchema.parse({})).toThrow();
    });
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

describe("CallSessionSchema", () => {
  // The rollover closes out calls the booth never finished and writes an
  // outcome of its own. It has to be part of the wire contract, or the
  // sessions list for an era that ended mid-call fails to parse.
  it("accepts the outcome a rollover writes", () => {
    const parsed = CallSessionSchema.parse({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      boothId: "booth-1",
      bootId: "bbbbbbbb-0000-4000-8000-000000000001",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      digitsDialed: null,
      outcome: "installation_ended",
      recordingId: null,
      durationMs: null,
      version: null,
    });

    expect(parsed.outcome).toBe("installation_ended");
  });
});

describe("telemetry token schema", () => {
  const telemetrySource = {
    boothId: "booth-01",
    componentId: "router-01",
    displayName: "Router",
    kind: "router",
    prometheusJob: "glinet-router",
    prometheusInstance: "router-01",
  };

  it("requires source metadata only for telemetry scope", () => {
    expect(
      CreateApiTokenRequestSchema.parse({
        name: "Router telemetry",
        scope: "telemetry",
        telemetrySource,
      }).telemetrySource,
    ).toEqual(telemetrySource);
    expect(() =>
      CreateApiTokenRequestSchema.parse({ name: "Unbound", scope: "telemetry" }),
    ).toThrow();
    expect(() =>
      CreateApiTokenRequestSchema.parse({
        name: "Operator",
        scope: "operator",
        telemetrySource,
      }),
    ).toThrow();
  });
});

describe("RouterComponentSnapshotSchema", () => {
  it("accepts signed battery current and preserves future fields", () => {
    const parsed = RouterComponentSnapshotSchema.parse({
      battery: {
        present: true,
        chargePercent: 72,
        temperatureCelsius: 31.5,
        voltageVolts: 7.8,
        currentAmperes: -1.25,
        health: "Good",
        technology: "Li-ion",
        cycleCount: 31,
        chargeCount: 147,
        abnormal: false,
        abnormalType: 0,
      },
      charger: {
        present: true,
        online: true,
        fastCharge: true,
        chargingStatus: 1,
      },
      thermalZones: [{ name: "soc", temperatureCelsius: 54.25 }],
      futureMetric: { value: 1 },
    });

    expect(parsed.battery?.currentAmperes).toBe(-1.25);
    expect(parsed.battery?.chargeCount).toBe(147);
    expect(parsed.battery?.abnormalType).toBe(0);
    expect(parsed.futureMetric).toEqual({ value: 1 });
  });

  it("rejects non-finite and unreasonable values", () => {
    expect(() =>
      RouterComponentSnapshotSchema.parse({
        battery: { chargePercent: 101 },
        thermalZones: [],
      }),
    ).toThrow();
    expect(() =>
      RouterComponentSnapshotSchema.parse({
        battery: { currentAmperes: Number.POSITIVE_INFINITY },
        thermalZones: [],
      }),
    ).toThrow();
    expect(() =>
      RouterComponentSnapshotSchema.parse({
        thermalZones: [{ name: "soc", temperatureCelsius: 500 }],
      }),
    ).toThrow();
    expect(() =>
      RouterComponentSnapshotSchema.parse({
        charger: { chargingStatus: "charging" },
        thermalZones: [],
      }),
    ).toThrow();
    expect(() =>
      RouterComponentSnapshotSchema.parse({
        battery: { abnormalType: "normal" },
        thermalZones: [],
      }),
    ).toThrow();
  });
});
