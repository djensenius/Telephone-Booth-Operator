import { describe, expect, it } from "vite-plus/test";
import {
  BoothNetworkStatsSchema,
  BoothStatusSchema,
  CallSessionSchema,
  CreateApiTokenRequestSchema,
  CurrentWeatherQuerySchema,
  CurrentWeatherSchema,
  InstallationSummarySchema,
  InstructionSchema,
  InstructionStatusSchema,
  InstructionUpdateSchema,
  MonitorSummarySchema,
  QuestionSchema,
  QuestionStatusSchema,
  RouterComponentSnapshotSchema,
  StatsOverviewSchema,
  StatsSummarySchema,
  ThermalHistoryQuerySchema,
  ThermalHistorySchema,
  ThermalMetricNameSchema,
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

describe("StatsSummarySchema", () => {
  const summary = {
    booth: {
      state: "idle",
      updatedAt: "2026-08-08T19:00:00.000Z",
    },
    messages: {
      pending: 2,
      awaitingModeration: 3,
      receivedToday: 4,
      latestId: "11111111-1111-4111-8111-111111111111",
    },
    interactions: {
      today: 5,
      inProgress: 1,
    },
    calls: {
      today: 5,
      inProgress: 1,
    },
    realtime: {
      wsClients: 2,
    },
    dayStartedAt: "2026-08-08T04:00:00.000Z",
    generatedAt: "2026-08-08T19:00:00.000Z",
    timeZone: "America/Toronto",
  };

  it("requires and preserves the effective calendar-day boundary", () => {
    const parsed = StatsSummarySchema.parse(summary);
    expect(parsed.dayStartedAt).toBe("2026-08-08T04:00:00.000Z");
    expect(parsed.timeZone).toBe("America/Toronto");
    expect(parsed.interactions).toEqual({ today: 5, inProgress: 1 });

    const { dayStartedAt: _dayStartedAt, ...withoutBoundary } = summary;
    expect(() => StatsSummarySchema.parse(withoutBoundary)).toThrow();
  });
});

describe("MonitorSummarySchema", () => {
  it("requires interaction totals, the all-time playback total, and the daily breakdown", () => {
    const parsed = MonitorSummarySchema.parse({
      interactionsToday: 5,
      interactionsTotal: 15,
      callsToday: 5,
      messagesToday: 4,
      callsTotal: 15,
      messagesTotal: 10,
      messagePlaybackStartsTotal: 6,
      breakdownToday: {
        noSelection: 1,
        wrongNumberAttempts: 2,
        messagesLeft: 3,
        messagePlaybackStarts: 4,
        instructionPlaybackStarts: 5,
      },
      dayStartedAt: "2026-08-08T04:00:00.000Z",
      generatedAt: "2026-08-08T19:00:00.000Z",
      timeZone: "America/Toronto",
    });

    expect(parsed.breakdownToday.wrongNumberAttempts).toBe(2);
    const { messagePlaybackStartsTotal: _messagePlaybackStartsTotal, ...withoutPlaybackTotal } =
      parsed;
    expect(() => MonitorSummarySchema.parse(withoutPlaybackTotal)).toThrow();

    expect(() =>
      MonitorSummarySchema.parse({
        callsToday: 5,
        messagesToday: 4,
        callsTotal: 15,
        messagesTotal: 10,
        messagePlaybackStartsTotal: 6,
        dayStartedAt: "2026-08-08T04:00:00.000Z",
        generatedAt: "2026-08-08T19:00:00.000Z",
        timeZone: "America/Toronto",
      }),
    ).toThrow();
  });
});

describe("InstallationSummarySchema", () => {
  it("defaults the interaction breakdown once an interactions alias is present", () => {
    const parsed = InstallationSummarySchema.parse({
      calls: 6,
      interactions: 6,
      messages: 2,
      allRecordings: 3,
      byStatus: { approved: 2, rejected: 1 },
      messagesApproved: 2,
      messagesRejected: 1,
      questions: 4,
      events: 10,
      recordedMs: 12_000,
      firstActivityAt: "2026-08-08T04:00:00.000Z",
      lastActivityAt: "2026-08-08T19:00:00.000Z",
    });

    expect(parsed.interactionBreakdown).toEqual({
      noSelection: 0,
      wrongNumberAttempts: 0,
      messagesLeft: 0,
      messagePlaybackStarts: 0,
      instructionPlaybackStarts: 0,
    });
  });
});

describe("StatsOverviewSchema", () => {
  it("requires interaction and action aliases alongside legacy fields", () => {
    const parsed = StatsOverviewSchema.parse({
      window: "24h",
      rangeStart: "2026-08-08T00:00:00.000Z",
      rangeEnd: "2026-08-09T00:00:00.000Z",
      generatedAt: "2026-08-09T00:00:00.000Z",
      timezone: "UTC",
      interactions: {
        total: 2,
        inProgressNow: 1,
        noSelection: 1,
        messagesLeft: 1,
        averageDurationMs: 1234,
        longestDurationMs: 2345,
        outcomes: { hung_up_before_dial: 1, recording_completed: 1 },
        perDay: [
          {
            date: "2026-08-08",
            total: 2,
            noSelection: 1,
            messagesLeft: 1,
          },
        ],
      },
      calls: {
        total: 2,
        completed: 1,
        inProgress: 1,
        averageDurationMs: 1234,
        longestDurationMs: 2345,
        outcomes: { recording_completed: 1 },
        perDay: [{ date: "2026-08-08", total: 2, completed: 1 }],
      },
      messages: {
        total: 1,
        approved: 1,
        allRecordings: 1,
        byStatus: { approved: 1 },
        averageDurationMs: 1500,
      },
      playback: { totalPlaybacks: 1 },
      actions: {
        digitsDialed: {
          "0": 0,
          "1": 1,
          "2": 0,
          "3": 0,
          "4": 0,
          "5": 0,
          "6": 0,
          "7": 0,
          "8": 0,
          "9": 0,
        },
        leaveMessageSelections: 1,
        listenMessageSelections: 0,
        instructionSelections: 0,
        wrongNumberAttempts: 0,
        messagePlaybackStarts: 1,
        instructionPlaybackStarts: 0,
      },
      pickupsHangups: {
        pickups: 2,
        hangups: 1,
        digitsDialed: {
          "0": 0,
          "1": 1,
          "2": 0,
          "3": 0,
          "4": 0,
          "5": 0,
          "6": 0,
          "7": 0,
          "8": 0,
          "9": 0,
        },
      },
      uploads: {
        succeeded: 1,
        failed: 0,
        failureRate: 0,
      },
      topQuestions: [],
      hourly: [{ hour: 8, interactions: 2, calls: 2, messages: 1 }],
      busiest: { hour: 8, dayOfWeek: 6 },
      lastActivityAt: "2026-08-08T19:00:00.000Z",
      boothBreakdown: [
        {
          boothId: "booth-1",
          interactions: 2,
          calls: 2,
          messages: null,
          lastSeenAt: "2026-08-08T19:00:00.000Z",
        },
      ],
    });

    expect(parsed.hourly[0]?.interactions).toBe(2);
    expect(parsed.boothBreakdown[0]?.interactions).toBe(2);
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

describe("thermal history schemas", () => {
  const source = {
    boothId: "booth-01",
    componentId: "router",
    displayName: "Travel router",
    kind: "router",
    prometheusJob: "glinet-router",
    prometheusInstance: "router-01",
  };

  it("accepts only the fixed thermal metric contract", () => {
    expect(ThermalMetricNameSchema.parse("booth_cpu_temperature_celsius")).toBe(
      "booth_cpu_temperature_celsius",
    );
    expect(() => ThermalMetricNameSchema.parse("process_temperature_celsius")).toThrow();

    const parsed = ThermalHistorySchema.parse({
      boothId: "booth-01",
      source,
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-18T00:00:00.000Z",
      stepSeconds: 60,
      series: [
        {
          metric: "glinet_battery_temperature_celsius",
          labels: { job: "glinet-router", instance: "router-01" },
          points: [{ timestamp: 1_776_643_200, value: 31.5 }],
        },
      ],
    });
    expect(parsed.source).toEqual(source);
  });

  it("requires response source metadata to match the requested booth", () => {
    expect(() =>
      ThermalHistorySchema.parse({
        boothId: "booth-02",
        source,
        from: "2026-08-17T00:00:00.000Z",
        to: "2026-08-18T00:00:00.000Z",
        stepSeconds: 60,
        series: [],
      }),
    ).toThrow();
  });

  it("uses the component-history 31-day and 10,000-point query bounds", () => {
    expect(
      ThermalHistoryQuerySchema.parse({
        boothId: "booth-01",
        from: "2026-08-17T00:00:00Z",
        to: "2026-08-18T00:00:00Z",
      }).stepSeconds,
    ).toBe(60);
    expect(() =>
      ThermalHistoryQuerySchema.parse({
        boothId: "booth-01",
        from: "2026-01-01T00:00:00Z",
        to: "2026-02-02T00:00:00Z",
      }),
    ).toThrow();
    expect(() =>
      ThermalHistoryQuerySchema.parse({
        boothId: "booth-01",
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-03T00:00:00Z",
        stepSeconds: 15,
      }),
    ).toThrow();
  });
});

describe("current weather schemas", () => {
  it("accepts bounded modeled weather and its booth query", () => {
    expect(CurrentWeatherQuerySchema.parse({ boothId: " booth-01 " })).toEqual({
      boothId: "booth-01",
    });
    expect(
      CurrentWeatherSchema.parse({
        boothId: "booth-01",
        source: "open_meteo",
        temperatureCelsius: 22.2,
        relativeHumidityPercent: 67,
        cloudCoverPercent: 12,
        condition: "clear_sky",
        observedAt: "2026-08-18T14:30:00.000Z",
        fetchedAt: "2026-08-18T14:31:00.000Z",
      }).condition,
    ).toBe("clear_sky");
  });

  it("rejects unknown conditions and out-of-range percentages", () => {
    expect(() =>
      CurrentWeatherSchema.parse({
        boothId: "booth-01",
        source: "open_meteo",
        temperatureCelsius: 22.2,
        relativeHumidityPercent: 101,
        cloudCoverPercent: 12,
        condition: "sunny",
        observedAt: "2026-08-18T14:30:00.000Z",
        fetchedAt: "2026-08-18T14:31:00.000Z",
      }),
    ).toThrow();
  });
});
