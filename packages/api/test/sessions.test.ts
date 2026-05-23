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
import { resetFakeDb } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

describe("sessions routes", () => {
  beforeEach(setup);

  it("lists derived sessions and returns a session detail with ordered events", async () => {
    const app = createApp();
    const sessionId = randomUUID();
    const bootId = randomUUID();
    const t0 = new Date(Date.now() - 5000).toISOString();
    const t1 = new Date(Date.now() - 4000).toISOString();
    const t2 = new Date(Date.now() - 3000).toISOString();
    await app.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({
        events: [
          { eventId: "s", boothId: "booth-01", bootId, type: "call_started", occurredAt: t0, sessionId, payload: {} },
          { eventId: "d", boothId: "booth-01", bootId, type: "digit_dialed", occurredAt: t1, sessionId, payload: { digit: 1 } },
          {
            eventId: "e",
            boothId: "booth-01",
            bootId,
            type: "call_ended",
            occurredAt: t2,
            sessionId,
            payload: { outcome: "hung_up_before_dial", duration_ms: 2000 },
          },
        ],
      }),
    });

    const cookie = operatorCookie();
    const list = await app.request("/v1/sessions", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { items: Array<{ id: string; outcome: string | null }> };
    expect(listJson.items).toHaveLength(1);
    expect(listJson.items[0]!.id).toBe(sessionId);
    expect(listJson.items[0]!.outcome).toBe("hung_up_before_dial");

    const detail = await app.request(`/v1/sessions/${sessionId}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailJson = (await detail.json()) as { id: string; events: Array<{ eventId: string }> };
    expect(detailJson.id).toBe(sessionId);
    expect(detailJson.events.map((event) => event.eventId)).toEqual(["s", "d", "e"]);

    const missing = await app.request(`/v1/sessions/${randomUUID()}`, { headers: { cookie } });
    expect(missing.status).toBe(404);
  });

  it("requires operator auth", async () => {
    const app = createApp();
    expect((await app.request("/v1/sessions")).status).toBe(401);
    expect((await app.request(`/v1/sessions/${randomUUID()}`)).status).toBe(401);
  });
});
