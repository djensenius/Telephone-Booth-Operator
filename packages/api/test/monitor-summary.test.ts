import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiTokenScope } from "@telephone-booth-operator/shared";

const tokenState = vi.hoisted(() => ({ scope: "monitor" as ApiTokenScope }));

vi.mock("../src/lib/api-tokens.js", () => ({
  verifyToken: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    scope: tokenState.scope,
  })),
}));
vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import { monitorRouter } from "../src/routes/monitor.js";
import {
  fakeDb,
  resetFakeDb,
  seedBoothEvent,
  seedCallSession,
  seedInstallation,
  seedMessage,
} from "./support/fake-db.js";
import { phoneHeaders } from "./support/http.js";

const app = new Hono();
app.route("/v1/monitor", monitorRouter);

describe("/v1/monitor/summary", () => {
  beforeEach(() => {
    tokenState.scope = "monitor";
    resetFakeDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T19:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("counts the active installation today and overall", async () => {
    const transaction = vi.spyOn(fakeDb, "$transaction");
    seedMessage({
      createdAt: new Date("2026-08-08T03:59:00.000Z"),
      receivedAt: new Date("2026-08-08T04:00:00.000Z"),
    });
    seedMessage({
      createdAt: new Date("2026-08-08T04:00:00.000Z"),
      receivedAt: new Date("2026-08-08T03:59:59.000Z"),
    });
    seedMessage({
      status: "uploading",
      createdAt: new Date("2026-08-08T04:00:00.000Z"),
      receivedAt: null,
    });
    seedCallSession({ startedAt: new Date("2026-08-08T03:59:59.000Z") });
    seedCallSession({
      startedAt: new Date("2026-08-08T04:00:00.000Z"),
      endedAt: new Date("2026-08-08T04:05:00.000Z"),
      outcome: "recording_completed",
    });
    seedCallSession({
      startedAt: new Date("2026-08-08T05:00:00.000Z"),
      endedAt: new Date("2026-08-08T05:00:10.000Z"),
      outcome: "hung_up_before_dial",
    });
    seedBoothEvent({
      type: "digit_dialed",
      occurredAt: new Date("2026-08-08T05:01:00.000Z"),
      payload: { digit: 7, kind: "digit_dialed", pulses: 7 },
    });
    seedBoothEvent({
      type: "state_transition",
      occurredAt: new Date("2026-08-08T05:02:00.000Z"),
      payload: { from: "idle", to: "playing_message", cause: "test" },
    });
    seedBoothEvent({
      type: "state_transition",
      occurredAt: new Date("2026-08-08T05:03:00.000Z"),
      payload: { from: "idle", to: "playing_instructions", cause: "test" },
    });
    const otherInstallation = seedInstallation({
      startedAt: new Date("2025-01-01T00:00:00.000Z"),
      endedAt: new Date("2025-12-31T23:59:59.000Z"),
    });
    seedMessage({
      installationId: otherInstallation.id,
      receivedAt: new Date("2026-08-08T05:00:00.000Z"),
    });
    seedCallSession({
      installationId: otherInstallation.id,
      startedAt: new Date("2026-08-08T05:00:00.000Z"),
    });

    const response = await app.request("/v1/monitor/summary?timeZone=America%2FToronto", {
      headers: phoneHeaders,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      interactionsToday: 2,
      interactionsTotal: 3,
      callsToday: 2,
      messagesToday: 1,
      callsTotal: 3,
      messagesTotal: 2,
      breakdownToday: {
        noSelection: 1,
        wrongNumberAttempts: 1,
        messagesLeft: 1,
        messagePlaybackStarts: 1,
        instructionPlaybackStarts: 1,
      },
      dayStartedAt: "2026-08-08T04:00:00.000Z",
      generatedAt: "2026-08-08T19:00:00.000Z",
      timeZone: "America/Toronto",
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
  });

  it("requires monitor credentials and validates the time zone", async () => {
    expect((await app.request("/v1/monitor/summary")).status).toBe(401);
    expect(
      (
        await app.request("/v1/monitor/summary?timeZone=Telephone%2FBooth", {
          headers: phoneHeaders,
        })
      ).status,
    ).toBe(400);
    tokenState.scope = "worker";
    expect((await app.request("/v1/monitor/summary", { headers: phoneHeaders })).status).toBe(403);
  });
});
