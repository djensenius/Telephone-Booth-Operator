import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock("../src/lib/azure-blob.js", async () => (await import("./support/fake-azure.js")).fakeAzureModule);
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken: () => async (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }, next: () => Promise<void>) => {
    if (c.req.header("authorization") === "Bearer test-token") {
      await next();
      return;
    }
    return c.json({ error: "invalid_token" }, 401);
  },
}));

import { randomUUID } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, store } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
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
          }),
          sampleEvent({
            eventId: "evt-end",
            bootId,
            sessionId,
            type: "call_ended",
            occurredAt: endedAt,
            payload: { outcome: "recording_completed", duration_ms: 4500, digits_dialed: "1" },
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
      sampleEvent({ eventId: "a", bootId, type: "digit_dialed", occurredAt: new Date(Date.now() - 3000).toISOString() }),
      sampleEvent({ eventId: "b", bootId, type: "digit_dialed", occurredAt: new Date(Date.now() - 2000).toISOString() }),
      sampleEvent({ eventId: "c", bootId, type: "state_transition", occurredAt: new Date(Date.now() - 1000).toISOString() }),
    ];
    await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ events }),
    });

    const cookie = operatorCookie();
    const all = await app.request("/v1/events?limit=10", { headers: { cookie } });
    expect(all.status).toBe(200);
    const allJson = (await all.json()) as { items: Array<{ eventId: string }>; nextCursor: string | null };
    expect(allJson.items).toHaveLength(3);
    expect(allJson.nextCursor).toBeNull();

    const filtered = await app.request("/v1/events?type=digit_dialed", { headers: { cookie } });
    const filteredJson = (await filtered.json()) as { items: Array<{ eventId: string }> };
    expect(filteredJson.items.map((event) => event.eventId).sort()).toEqual(["a", "b"]);

    const firstPage = await app.request("/v1/events?limit=2", { headers: { cookie } });
    const firstJson = (await firstPage.json()) as { items: Array<{ eventId: string }>; nextCursor: string | null };
    expect(firstJson.items).toHaveLength(2);
    expect(firstJson.nextCursor).not.toBeNull();
    const secondPage = await app.request(`/v1/events?limit=2&cursor=${encodeURIComponent(firstJson.nextCursor!)}`, { headers: { cookie } });
    const secondJson = (await secondPage.json()) as { items: Array<{ eventId: string }>; nextCursor: string | null };
    expect(secondJson.items).toHaveLength(1);
  });
});
