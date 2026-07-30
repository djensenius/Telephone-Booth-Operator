import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken:
    () =>
    async (
      c: {
        req: { header: (name: string) => string | undefined };
        json: (body: unknown, status?: number) => Response;
      },
      next: () => Promise<void>,
    ) => {
      if (c.req.header("authorization") === "Bearer test-token") {
        await next();
        return;
      }
      return c.json({ error: "invalid_token" }, 401);
    },
}));

import { randomUUID } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetInstallationCacheForTests } from "../src/lib/installation.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import {
  DEFAULT_INSTALLATION_ID,
  resetFakeDb,
  seedCallSession,
  seedInstallation,
  store,
} from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetInstallationCacheForTests();
};

const sampleEvent = (overrides: Record<string, unknown> = {}) => ({
  eventId: randomUUID(),
  boothId: "booth-01",
  bootId: randomUUID(),
  type: "digit_dialed",
  occurredAt: new Date().toISOString(),
  payload: { digit: 1 },
  ...overrides,
});

describe("POST /v1/events", () => {
  beforeEach(setup);

  it("rejects unauthenticated POST", async () => {
    const app = createApp();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [sampleEvent()] }),
    });
    expect(res.status).toBe(401);
  });

  it("bulk-inserts events with skipDuplicates idempotency", async () => {
    const app = createApp();
    const eventId = randomUUID();
    const body = { events: [sampleEvent({ eventId })] };
    const first = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ accepted: 1, duplicates: 0 });

    const second = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ accepted: 0, duplicates: 1 });
    expect(store.boothEvents).toHaveLength(1);
  });

  it("upserts a CallSession on call_started/call_ended", async () => {
    const app = createApp();
    const sessionId = randomUUID();
    const bootId = randomUUID();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const endedAt = new Date().toISOString();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({
        events: [
          sampleEvent({
            eventId: "evt-start",
            bootId,
            sessionId,
            type: "call_started",
            occurredAt: startedAt,
            payload: {},
            version: "0.3.2",
          }),
          sampleEvent({
            eventId: "evt-end",
            bootId,
            sessionId,
            type: "call_ended",
            occurredAt: endedAt,
            payload: { outcome: "recording_completed", duration_ms: 4500, digits_dialed: "1" },
            version: "0.3.2",
          }),
        ],
      }),
    });
    expect(res.status).toBe(200);
    const session = store.callSessions.get(sessionId);
    expect(session).toBeDefined();
    expect(session?.startedAt.toISOString()).toBe(startedAt);
    expect(session?.endedAt?.toISOString()).toBe(endedAt);
    expect(session?.outcome).toBe("recording_completed");
    expect(session?.durationMs).toBe(4500);
    expect(session?.digitsDialed).toBe("1");
    expect(session?.version).toBe("0.3.2");
    // The event row must also carry the booth client version verbatim.
    const startEvent = store.boothEvents.find((event) => event.eventId === "evt-start");
    expect(startEvent?.version).toBe("0.3.2");
  });
});

describe("GET /v1/events", () => {
  beforeEach(setup);

  it("requires operator auth", async () => {
    const app = createApp();
    const res = await app.request("/v1/events");
    expect(res.status).toBe(401);
  });

  it("returns paginated events with filters and cursor", async () => {
    const app = createApp();
    const bootId = randomUUID();
    // Seed 3 events by POSTing them.
    const events = [
      sampleEvent({
        eventId: "a",
        bootId,
        type: "digit_dialed",
        occurredAt: new Date(Date.now() - 3000).toISOString(),
      }),
      sampleEvent({
        eventId: "b",
        bootId,
        type: "digit_dialed",
        occurredAt: new Date(Date.now() - 2000).toISOString(),
      }),
      sampleEvent({
        eventId: "c",
        bootId,
        type: "state_transition",
        occurredAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ];
    await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ events }),
    });

    const cookie = operatorCookie();
    const all = await app.request("/v1/events?limit=10", { headers: { cookie } });
    expect(all.status).toBe(200);
    const allJson = (await all.json()) as {
      items: Array<{ eventId: string }>;
      nextCursor: string | null;
    };
    expect(allJson.items).toHaveLength(3);
    expect(allJson.nextCursor).toBeNull();

    const filtered = await app.request("/v1/events?type=digit_dialed", { headers: { cookie } });
    const filteredJson = (await filtered.json()) as { items: Array<{ eventId: string }> };
    expect(filteredJson.items.map((event) => event.eventId).sort()).toEqual(["a", "b"]);

    const firstPage = await app.request("/v1/events?limit=2", { headers: { cookie } });
    const firstJson = (await firstPage.json()) as {
      items: Array<{ eventId: string }>;
      nextCursor: string | null;
    };
    expect(firstJson.items).toHaveLength(2);
    expect(firstJson.nextCursor).not.toBeNull();
    const secondPage = await app.request(
      `/v1/events?limit=2&cursor=${encodeURIComponent(firstJson.nextCursor!)}`,
      { headers: { cookie } },
    );
    const secondJson = (await secondPage.json()) as {
      items: Array<{ eventId: string }>;
      nextCursor: string | null;
    };
    expect(secondJson.items).toHaveLength(1);
  });

  // A booth can report a `call_ended` after an admin has already closed the
  // era. The rollover's close-out is terminal: the straggler must not rewrite
  // the frozen session, or the ended era's summary stops matching its own
  // drill-down.
  it("does not let a late call_ended rewrite a session frozen by a rollover", async () => {
    const nextEra = "22222222-2222-4222-8222-222222222222";
    seedInstallation({ id: nextEra });
    store.installations.get(DEFAULT_INSTALLATION_ID)!.endedAt = new Date("2026-01-01T00:00:00Z");
    const frozen = seedCallSession({
      id: "11111111-1111-4111-8111-111111111111",
      bootId: "33333333-3333-4333-8333-333333333333",
      endedAt: new Date("2026-01-01T00:00:00Z"),
      outcome: "installation_ended",
      installationId: DEFAULT_INSTALLATION_ID,
    });

    const res = await createApp().request("/v1/events", {
      method: "POST",
      headers: { ...phoneHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventId: "late-1",
            boothId: "booth-1",
            bootId: "33333333-3333-4333-8333-333333333333",
            type: "call_ended",
            occurredAt: new Date("2026-02-01T00:00:00Z").toISOString(),
            sessionId: frozen.id,
            payload: { outcome: "completed", duration_ms: 4242 },
          },
        ],
      }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    const after = store.callSessions.get(frozen.id)!;
    expect(after.outcome).toBe("installation_ended");
    expect(after.durationMs).toBeNull();
    expect(after.installationId).toBe(DEFAULT_INSTALLATION_ID);
    // The event travels with its session rather than with whatever era is open.
    const event = store.boothEvents.find((row) => row.eventId === "late-1");
    expect(event?.installationId).toBe(DEFAULT_INSTALLATION_ID);
  });

  // The pre-flight "is this session frozen?" read happens before the write
  // transaction, so a rollover committing in between must still be refused —
  // this time by the database condition on the update itself.
  // A session that ended normally before the rollover keeps its own outcome,
  // so the guard cannot key on `installation_ended` alone: what makes it
  // untouchable is that its era is closed.
  it("refuses a replayed call_ended for a normally ended session in a closed era", async () => {
    store.installations.get(DEFAULT_INSTALLATION_ID)!.endedAt = new Date("2026-01-01T00:00:00Z");
    const settled = seedCallSession({
      id: "11111111-1111-4111-8111-11111111000b",
      bootId: "33333333-3333-4333-8333-33333333000b",
      endedAt: new Date("2025-12-31T00:00:00Z"),
      outcome: "recording_completed",
      durationMs: 1000,
      installationId: DEFAULT_INSTALLATION_ID,
    });

    const res = await createApp().request("/v1/events", {
      method: "POST",
      headers: { ...phoneHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventId: "late-3",
            boothId: "booth-1",
            bootId: "33333333-3333-4333-8333-33333333000b",
            type: "call_ended",
            occurredAt: new Date("2026-02-01T00:00:00Z").toISOString(),
            sessionId: settled.id,
            payload: { outcome: "hangup_before_recording", duration_ms: 9999 },
          },
        ],
      }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    const after = store.callSessions.get(settled.id)!;
    expect(after.outcome).toBe("recording_completed");
    expect(after.durationMs).toBe(1000);
  });

  it("refuses a straggler whose era closed after the frozen check", async () => {
    const stale = seedCallSession({
      id: "11111111-1111-4111-8111-11111111000a",
      bootId: "33333333-3333-4333-8333-33333333000a",
      // Still looks open to the pre-flight read: no endedAt, era not closed.
      outcome: "installation_ended",
      installationId: DEFAULT_INSTALLATION_ID,
    });

    const res = await createApp().request("/v1/events", {
      method: "POST",
      headers: { ...phoneHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            eventId: "late-2",
            boothId: "booth-1",
            bootId: "33333333-3333-4333-8333-33333333000a",
            type: "call_ended",
            occurredAt: new Date("2026-02-01T00:00:00Z").toISOString(),
            sessionId: stale.id,
            payload: { outcome: "completed", duration_ms: 4242 },
          },
        ],
      }),
    });

    expect(res.status, await res.clone().text()).toBe(200);
    const after = store.callSessions.get(stale.id)!;
    expect(after.outcome).toBe("installation_ended");
    expect(after.durationMs).toBeNull();
  });
});
