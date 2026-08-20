import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import {
  parseInstallationSummaryBackfillArgs,
  runInstallationSummaryBackfill,
} from "../src/lib/installation-summary-backfill.js";
import {
  resetFakeDb,
  seedBoothEvent,
  seedCallSession,
  seedFile,
  seedInstallation,
  seedMessage,
  store,
  fakeDb,
} from "./support/fake-db.js";

const seedEndedInstallation = () => {
  const installation = seedInstallation({
    name: "Ended Installation",
    startedAt: new Date("2026-08-01T00:00:00.000Z"),
    endedAt: new Date("2026-08-02T00:00:00.000Z"),
    summary: {
      calls: 2,
      messages: 1,
      messagesApproved: 1,
      messagesRejected: 0,
      questions: 0,
      events: 3,
      recordedMs: 0,
      firstActivityAt: null,
      lastActivityAt: null,
    },
  });
  const approvedAudio = seedFile({ durationMs: 3_000 });
  seedMessage({
    installationId: installation.id,
    status: "approved",
    audioId: approvedAudio.id,
    receivedAt: new Date("2026-08-01T12:10:00.000Z"),
  });
  seedCallSession({
    installationId: installation.id,
    startedAt: new Date("2026-08-01T12:00:00.000Z"),
    endedAt: new Date("2026-08-01T12:01:00.000Z"),
    outcome: "recording_completed",
    durationMs: 60_000,
    digitsDialed: "1",
  });
  seedCallSession({
    installationId: installation.id,
    startedAt: new Date("2026-08-01T13:00:00.000Z"),
    endedAt: new Date("2026-08-01T13:00:10.000Z"),
    outcome: "hung_up_before_dial",
    durationMs: 10_000,
  });
  seedBoothEvent({
    installationId: installation.id,
    type: "digit_dialed",
    occurredAt: new Date("2026-08-01T13:00:01.000Z"),
    payload: { digit: 7, kind: "digit_dialed", pulses: 7 },
  });
  seedBoothEvent({
    installationId: installation.id,
    type: "state_transition",
    occurredAt: new Date("2026-08-01T12:00:05.000Z"),
    payload: { from: "idle", to: "playing_message", cause: "test" },
  });
  seedBoothEvent({
    installationId: installation.id,
    type: "state_transition",
    occurredAt: new Date("2026-08-01T12:00:06.000Z"),
    payload: { from: "idle", to: "playing_instructions", cause: "test" },
  });
  return installation;
};

const makeLogger = () => {
  const info = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  return { info, error };
};

describe("installation summary backfill", () => {
  beforeEach(() => {
    resetFakeDb();
  });

  it("parses dry-run and apply CLI arguments", () => {
    expect(parseInstallationSummaryBackfillArgs([])).toEqual({ apply: false });
    expect(parseInstallationSummaryBackfillArgs(["--apply"])).toEqual({ apply: true });
    expect(() => parseInstallationSummaryBackfillArgs(["--bogus"])).toThrow("Unknown argument");
  });

  it("reports dry-run changes without mutating frozen summaries", async () => {
    const installation = seedEndedInstallation();
    const logger = makeLogger();

    const report = await runInstallationSummaryBackfill(fakeDb, logger, { apply: false });

    expect(report).toEqual({
      apply: false,
      endedInstallations: 1,
      changed: 1,
      unchanged: 0,
      applied: 0,
      failures: [],
    });
    expect(store.installations.get(installation.id)?.summary).toEqual({
      calls: 2,
      messages: 1,
      messagesApproved: 1,
      messagesRejected: 0,
      questions: 0,
      events: 3,
      recordedMs: 0,
      firstActivityAt: null,
      lastActivityAt: null,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("would update"));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("applies the recomputed summary and is safe to rerun", async () => {
    const installation = seedEndedInstallation();
    const logger = makeLogger();

    const first = await runInstallationSummaryBackfill(fakeDb, logger, { apply: true });
    expect(first).toEqual({
      apply: true,
      endedInstallations: 1,
      changed: 1,
      unchanged: 0,
      applied: 1,
      failures: [],
    });
    expect(store.installations.get(installation.id)?.summary).toMatchObject({
      calls: 2,
      interactions: 2,
      interactionBreakdown: {
        noSelection: 1,
        wrongNumberAttempts: 1,
        messagesLeft: 1,
        messagePlaybackStarts: 1,
        instructionPlaybackStarts: 1,
      },
      messages: 1,
      allRecordings: 1,
      recordedMs: 3_000,
    });

    const second = await runInstallationSummaryBackfill(fakeDb, logger, { apply: true });
    expect(second).toEqual({
      apply: true,
      endedInstallations: 1,
      changed: 0,
      unchanged: 1,
      applied: 0,
      failures: [],
    });
  });
});
