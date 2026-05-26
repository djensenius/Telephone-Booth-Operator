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
import { resetFakeDb } from "./support/fake-db.js";
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

  it("keeps GET public, protects PUT with bearer auth, and returns history to operators", async () => {
    const app = createApp();

    const initial = await app.request("/v1/status");
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

    const latest = await app.request("/v1/status");
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

  it("persists and echoes the booth runtimeMode", async () => {
    const app = createApp();

    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "idle", runtimeMode: "mock" }),
    });
    expect(put.status).toBe(204);

    const latest = await app.request("/v1/status");
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
    const latestSim = await app.request("/v1/status");
    await expect(latestSim.json()).resolves.toMatchObject({ runtimeMode: "simulator" });
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
});
