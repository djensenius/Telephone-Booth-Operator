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

import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { fakeDb, resetFakeDb, seedCallSession } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

describe("status routes", () => {
  beforeEach(setup);

  it("requires auth for GET, protects PUT with bearer auth, and returns history to operators", async () => {
    const app = createApp();

    // GET now requires authentication — unauthenticated callers get 401.
    const anon = await app.request("/v1/status");
    expect(anon.status).toBe(401);

    // An operator session (cookie) can read the snapshot.
    const initial = await app.request("/v1/status", { headers: { cookie: operatorCookie() } });
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({ state: "idle" });

    const denied = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "recording" }),
    });
    expect(denied.status).toBe(401);

    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "recording", lastError: null }),
    });
    expect(put.status).toBe(204);

    // The booth/phone client can also read the snapshot with its API token.
    const latest = await app.request("/v1/status", { headers: { ...phoneHeaders } });
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toMatchObject({ state: "recording", lastError: null });

    const noCookie = await app.request("/v1/status/history");
    expect(noCookie.status).toBe(401);

    const history = await app.request("/v1/status/history?limit=10", {
      headers: { cookie: operatorCookie() },
    });
    expect(history.status).toBe(200);
    const body = await history.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ state: "recording" });
  });

  it("collapses repeated identical status reports into one counted snapshot", async () => {
    const app = createApp();

    const beat = async (body: Record<string, unknown>) => {
      const response = await app.request("/v1/status", {
        method: "PUT",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(204);
    };

    // Three identical idle heartbeats plus a genuine transition and a return to
    // idle: the history should read as three rows, not five.
    await beat({ state: "idle", updatedAt: "2026-07-28T12:00:00.000Z" });
    await beat({ state: "idle", updatedAt: "2026-07-28T12:00:10.000Z" });
    await beat({ state: "idle", updatedAt: "2026-07-28T12:00:20.000Z" });
    await beat({ state: "recording", updatedAt: "2026-07-28T12:00:30.000Z" });
    await beat({ state: "idle", updatedAt: "2026-07-28T12:00:40.000Z" });

    const history = await app.request("/v1/status/history?limit=10", {
      headers: { cookie: operatorCookie() },
    });
    const body = await history.json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({
      state: "idle",
      repeatCount: 1,
      firstSeenAt: "2026-07-28T12:00:40.000Z",
      updatedAt: "2026-07-28T12:00:40.000Z",
    });
    expect(body.items[1]).toMatchObject({ state: "recording", repeatCount: 1 });
    // The collapsed run spans its first report through its most recent one.
    expect(body.items[2]).toMatchObject({
      state: "idle",
      repeatCount: 3,
      firstSeenAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:20.000Z",
    });
  });

  it("does not collapse reports whose fields differ", async () => {
    const app = createApp();

    const beat = async (body: Record<string, unknown>) => {
      const response = await app.request("/v1/status", {
        method: "PUT",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(204);
    };

    await beat({ state: "error", lastError: "no dial tone" });
    await beat({ state: "error", lastError: "line down" });
    await beat({ state: "error", lastError: "line down", runtimeMode: "mock" });

    const history = await app.request("/v1/status/history?limit=10", {
      headers: { cookie: operatorCookie() },
    });
    const body = await history.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item: { repeatCount: number }) => item.repeatCount === 1)).toBe(true);
  });

  it("widens the collapsed window when a repeat arrives out of order", async () => {
    const app = createApp();

    const beat = async (updatedAt: string) => {
      const response = await app.request("/v1/status", {
        method: "PUT",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ state: "idle", updatedAt }),
      });
      expect(response.status).toBe(204);
    };

    await beat("2026-07-28T12:00:10.000Z");
    // A delayed heartbeat generated before the one already stored must not
    // rewind `updatedAt`, but it does extend the window backwards.
    await beat("2026-07-28T12:00:00.000Z");

    const history = await app.request("/v1/status/history?limit=10", {
      headers: { cookie: operatorCookie() },
    });
    const body = await history.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      repeatCount: 2,
      firstSeenAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:10.000Z",
    });
  });

  it("persists and echoes the booth runtimeMode", async () => {
    const app = createApp();

    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", runtimeMode: "mock" }),
    });
    expect(put.status).toBe(204);

    const latest = await app.request("/v1/status", { headers: { ...phoneHeaders } });
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toMatchObject({ state: "idle", runtimeMode: "mock" });

    // Simulator wins over mock — the booth side resolves that and just sends
    // the resulting mode; the operator must persist whatever it receives.
    const sim = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", runtimeMode: "simulator" }),
    });
    expect(sim.status).toBe(204);
    const latestSim = await app.request("/v1/status", { headers: { ...phoneHeaders } });
    await expect(latestSim.json()).resolves.toMatchObject({ runtimeMode: "simulator" });
  });

  it("accepts the callUnavailable booth state", async () => {
    const app = createApp();
    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "callUnavailable" }),
    });
    expect(put.status).toBe(204);

    const latest = await app.request("/v1/status", { headers: { ...phoneHeaders } });
    await expect(latest.json()).resolves.toMatchObject({ state: "callUnavailable" });
  });

  it("rejects an invalid runtimeMode value", async () => {
    const app = createApp();
    const bad = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", runtimeMode: "production" }),
    });
    expect(bad.status).toBe(400);
  });

  it("reconciles stale open call sessions when the booth reports idle", async () => {
    const app = createApp();

    // A stale session whose call_ended never arrived (endedAt stays null).
    const startedAt = new Date(Date.now() - 60_000);
    const stale = seedCallSession({ startedAt, endedAt: null });
    // A previously-completed session must not be touched.
    const completedEndedAt = new Date(Date.now() - 120_000);
    const completed = seedCallSession({
      startedAt: new Date(Date.now() - 180_000),
      endedAt: completedEndedAt,
      outcome: "recording_completed",
      durationMs: 60_000,
    });

    expect(await fakeDb.callSession.count({ where: { endedAt: null } })).toBe(1);

    const idleTime = new Date();
    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", updatedAt: idleTime.toISOString() }),
    });
    expect(put.status).toBe(204);

    // The stale session is closed as aborted; duration is null because the real
    // end time is unknown (its call_ended was never delivered).
    const reconciled = await fakeDb.callSession.findUnique({ where: { id: stale.id } });
    expect(reconciled?.endedAt?.toISOString()).toBe(idleTime.toISOString());
    expect(reconciled?.outcome).toBe("aborted");
    expect(reconciled?.durationMs).toBeNull();

    // inProgress is back to the true count.
    expect(await fakeDb.callSession.count({ where: { endedAt: null } })).toBe(0);

    // The already-completed session is untouched — completion-rate is honest.
    const untouched = await fakeDb.callSession.findUnique({ where: { id: completed.id } });
    expect(untouched?.outcome).toBe("recording_completed");
    expect(untouched?.endedAt?.toISOString()).toBe(completedEndedAt.toISOString());
    expect(untouched?.durationMs).toBe(60_000);

    // Reconciliation is idempotent — a second idle update closes nothing new.
    const putAgain = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle" }),
    });
    expect(putAgain.status).toBe(204);
    expect(await fakeDb.callSession.count({ where: { endedAt: null } })).toBe(0);
  });

  it("does not reconcile open sessions for non-idle status updates", async () => {
    const app = createApp();
    seedCallSession({ startedAt: new Date(Date.now() - 60_000), endedAt: null });

    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "recording" }),
    });
    expect(put.status).toBe(204);

    // A live call must not be closed while the booth is mid-call.
    expect(await fakeDb.callSession.count({ where: { endedAt: null } })).toBe(1);
  });

  it("leaves a session that started after the idle timestamp open", async () => {
    const app = createApp();

    const idleTime = new Date(Date.now() - 60_000);
    // A newer live call started after a delayed idle report was generated. The
    // `startedAt <= idleTime` guard must protect it from being closed.
    const fresh = seedCallSession({ startedAt: new Date(), endedAt: null });

    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", updatedAt: idleTime.toISOString() }),
    });
    expect(put.status).toBe(204);

    const untouched = await fakeDb.callSession.findUnique({ where: { id: fresh.id } });
    expect(untouched?.endedAt).toBeNull();
    expect(untouched?.outcome).toBeNull();
    expect(await fakeDb.callSession.count({ where: { endedAt: null } })).toBe(1);
  });
});
