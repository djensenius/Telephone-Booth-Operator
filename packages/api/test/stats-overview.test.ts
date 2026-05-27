import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { randomUUID } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetStatsCacheForTests } from "../src/routes/stats.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import {
  resetFakeDb,
  seedCallSession,
  seedFile,
  seedMessage,
  seedQuestion,
  store,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetStatsCacheForTests();
};

const pushEvent = (overrides: {
  type: string;
  occurredAt: Date;
  payload?: unknown;
  boothId?: string;
}): void => {
  store.boothEvents.push({
    id: randomUUID(),
    eventId: randomUUID(),
    boothId: overrides.boothId ?? "booth-1",
    bootId: "boot-1",
    type: overrides.type,
    occurredAt: overrides.occurredAt,
    receivedAt: overrides.occurredAt,
    sessionId: null,
    recordingId: null,
    payload: overrides.payload ?? {},
  });
};

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60 * 1000);
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("GET /v1/stats/overview", () => {
  beforeEach(setup);

  it("rejects unauthenticated requests", async () => {
    const app = createApp();
    const res = await app.request("/v1/stats/overview");
    expect(res.status).toBe(401);
  });

  it("rejects unknown window values", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=bogus", {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_window" });
  });

  it("returns a zero-filled overview for an empty database", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      window: "7d",
      timezone: "UTC",
      calls: {
        total: 0,
        completed: 0,
        inProgress: 0,
        averageDurationMs: null,
        longestDurationMs: null,
        outcomes: {},
      },
      messages: { total: 0, byStatus: {}, averageDurationMs: null },
      playback: { totalPlaybacks: 0 },
      pickupsHangups: { pickups: 0, hangups: 0 },
      uploads: { succeeded: 0, failed: 0, failureRate: null },
      topQuestions: [],
      busiest: { hour: null, dayOfWeek: null },
      lastActivityAt: null,
      boothBreakdown: [],
    });
    expect(body.hourly).toHaveLength(24);
    expect(body.pickupsHangups.digitsDialed).toMatchObject({
      "0": 0,
      "9": 0,
    });
    expect(body.calls.perDay.length).toBeGreaterThan(0); // zero-filled days
  });

  it("aggregates calls, messages, playbacks, uploads, and top questions", async () => {
    // Two questions, the second is more popular.
    const q1 = seedQuestion({ prompt: "What is your favorite color?" });
    const q2 = seedQuestion({ prompt: "Tell us a secret" });

    // Three completed calls in the 7d window, one in-progress, one
    // outside the window.
    seedCallSession({
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(28),
      outcome: "recording_completed",
      durationMs: 2000,
      digitsDialed: "1234",
      boothId: "booth-1",
    });
    seedCallSession({
      startedAt: daysAgo(2),
      endedAt: daysAgo(2),
      outcome: "recording_completed",
      durationMs: 8000,
      digitsDialed: "5",
      boothId: "booth-1",
    });
    seedCallSession({
      startedAt: daysAgo(3),
      endedAt: daysAgo(3),
      outcome: "hung_up_before_dial",
      durationMs: 100,
      digitsDialed: null,
      boothId: "booth-2",
    });
    seedCallSession({
      startedAt: minutesAgo(5),
      endedAt: null,
      boothId: "booth-1",
    });
    // Outside window:
    seedCallSession({
      startedAt: daysAgo(20),
      endedAt: daysAgo(20),
      outcome: "recording_completed",
      durationMs: 3000,
      boothId: "booth-1",
    });

    // Messages: 4 inside window (3 for q2, 1 for q1), 1 outside.
    const f1 = seedFile({ durationMs: 1000, sha256: "a".repeat(64) });
    const f2 = seedFile({ durationMs: 2000, sha256: "b".repeat(64) });
    const f3 = seedFile({ durationMs: 3000, sha256: "c".repeat(64) });
    const f4 = seedFile({ durationMs: 4000, sha256: "d".repeat(64) });
    const f5 = seedFile({ durationMs: 9999, sha256: "e".repeat(64) });
    seedMessage({ status: "approved", questionId: q2.id, audioId: f1.id, createdAt: daysAgo(1) });
    seedMessage({ status: "approved", questionId: q2.id, audioId: f2.id, createdAt: daysAgo(2) });
    seedMessage({ status: "pending", questionId: q2.id, audioId: f3.id, createdAt: daysAgo(3) });
    seedMessage({ status: "rejected", questionId: q1.id, audioId: f4.id, createdAt: daysAgo(4) });
    seedMessage({ status: "approved", questionId: q1.id, audioId: f5.id, createdAt: daysAgo(40) });

    // Booth events: 2 playbacks in window, 1 with payload.to != playing_message
    // (must not be counted), and 1 outside window.
    pushEvent({
      type: "state_transition",
      occurredAt: minutesAgo(10),
      payload: { from: "idle", to: "playing_message", cause: "test" },
    });
    pushEvent({
      type: "state_transition",
      occurredAt: daysAgo(2),
      payload: { from: "idle", to: "playing_message", cause: "test" },
    });
    pushEvent({
      type: "state_transition",
      occurredAt: minutesAgo(5),
      payload: { from: "playing_message", to: "idle", cause: "playback_done" },
    });
    pushEvent({
      type: "state_transition",
      occurredAt: daysAgo(20),
      payload: { from: "idle", to: "playing_message", cause: "test" },
    });

    // Upload events: 2 succeeded, 1 failed in window.
    pushEvent({ type: "upload_completed", occurredAt: daysAgo(1) });
    pushEvent({ type: "upload_completed", occurredAt: daysAgo(2) });
    pushEvent({ type: "upload_failed", occurredAt: daysAgo(2) });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=7d", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.calls.total).toBe(4); // 3 ended + 1 in-progress inside window
    expect(body.calls.completed).toBe(2);
    expect(body.calls.inProgress).toBe(1);
    expect(body.calls.outcomes).toMatchObject({
      recording_completed: 2,
      hung_up_before_dial: 1,
    });
    expect(body.calls.averageDurationMs).toBeCloseTo((2000 + 8000 + 100) / 3, 5);
    expect(body.calls.longestDurationMs).toBe(8000);

    expect(body.messages.total).toBe(4);
    expect(body.messages.byStatus).toMatchObject({
      approved: 2,
      pending: 1,
      rejected: 1,
    });
    expect(body.messages.averageDurationMs).toBe((1000 + 2000 + 3000 + 4000) / 4);

    expect(body.playback.totalPlaybacks).toBe(2);

    expect(body.pickupsHangups.pickups).toBe(4);
    expect(body.pickupsHangups.hangups).toBe(3);
    expect(body.pickupsHangups.digitsDialed["1"]).toBe(1);
    expect(body.pickupsHangups.digitsDialed["5"]).toBe(1);

    expect(body.uploads).toEqual({
      succeeded: 2,
      failed: 1,
      failureRate: 1 / 3,
    });

    expect(body.topQuestions).toHaveLength(2);
    expect(body.topQuestions[0]).toMatchObject({
      questionId: q2.id,
      messageCount: 3,
    });
    expect(body.topQuestions[1]).toMatchObject({
      questionId: q1.id,
      messageCount: 1,
    });

    expect(body.boothBreakdown.length).toBeGreaterThanOrEqual(2);
    const boothIds = body.boothBreakdown.map((entry: { boothId: string }) => entry.boothId).sort();
    expect(boothIds).toEqual(["booth-1", "booth-2"]);

    expect(body.lastActivityAt).not.toBeNull();
  });

  it("tolerates unknown outcome strings and missing JSON payload fields", async () => {
    seedCallSession({
      startedAt: minutesAgo(30),
      endedAt: minutesAgo(28),
      outcome: "wild_new_outcome",
      durationMs: 500,
    });
    pushEvent({
      type: "state_transition",
      occurredAt: minutesAgo(10),
      payload: null,
    });
    pushEvent({
      type: "state_transition",
      occurredAt: minutesAgo(9),
      payload: { from: "idle" },
    });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=24h", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls.outcomes).toMatchObject({ wild_new_outcome: 1 });
    expect(body.playback.totalPlaybacks).toBe(0); // neither payload had to=playing_message
  });

  it("returns boothBreakdown only when more than one booth has data", async () => {
    seedCallSession({ startedAt: minutesAgo(30), endedAt: minutesAgo(28), boothId: "booth-1" });
    seedCallSession({ startedAt: minutesAgo(10), endedAt: null, boothId: "booth-1" });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=24h", { headers: { cookie } });
    const body = await res.json();
    expect(body.boothBreakdown).toEqual([]);
  });

  it("counts hangups by endedAt so boundary-spanning calls reconcile", async () => {
    // Started 2h before the 24h window, ended inside the window — should
    // count as one hangup (and not as a pickup).
    seedCallSession({
      startedAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
      endedAt: minutesAgo(30),
      outcome: "recording_completed",
      durationMs: 1000,
      boothId: "booth-1",
    });
    // Started inside the window but still in progress — pickup, no hangup.
    seedCallSession({
      startedAt: minutesAgo(10),
      endedAt: null,
      boothId: "booth-1",
    });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=24h", { headers: { cookie } });
    const body = await res.json();
    expect(body.pickupsHangups.pickups).toBe(1);
    expect(body.pickupsHangups.hangups).toBe(1);
    expect(body.calls.completed).toBe(1);
  });

  it("respects the 24h window — calls older than 24h are excluded", async () => {
    seedCallSession({ startedAt: minutesAgo(30), endedAt: minutesAgo(28), boothId: "booth-1" });
    seedCallSession({ startedAt: daysAgo(2), endedAt: daysAgo(2), boothId: "booth-1" });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=24h", { headers: { cookie } });
    const body = await res.json();
    expect(body.calls.total).toBe(1);
  });

  it("returns window=all without rangeStart and includes historical data", async () => {
    seedCallSession({ startedAt: daysAgo(400), endedAt: daysAgo(400), boothId: "booth-1" });
    seedCallSession({ startedAt: minutesAgo(5), endedAt: minutesAgo(4), boothId: "booth-1" });

    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/overview?window=all", { headers: { cookie } });
    const body = await res.json();
    expect(body.window).toBe("all");
    expect(body.rangeStart).toBeNull();
    expect(body.calls.total).toBe(2);
  });
});
