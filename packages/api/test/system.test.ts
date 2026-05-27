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
import { clearSystemSnapshotsForTests } from "../src/lib/system-cache.js";
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
  clearSystemSnapshotsForTests();
};

const sampleSnapshot = {
  cpu: { usageRatio: 0.12, loadAvg1m: 0.12, physicalCores: 4 },
  temperatureCelsius: 48.5,
  memory: { totalBytes: 2048, usedBytes: 1024 },
  uptimeSeconds: 60,
};

describe("system routes", () => {
  beforeEach(setup);

  it("rejects unauthenticated PUT and serves the latest snapshot via GET", async () => {
    const app = createApp();
    const denied = await app.request("/v1/system", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boothId: "booth-01", snapshot: sampleSnapshot }),
    });
    expect(denied.status).toBe(401);

    const put = await app.request("/v1/system", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ boothId: "booth-01", snapshot: sampleSnapshot }),
    });
    expect(put.status).toBe(204);

    const missing = await app.request("/v1/system/current?boothId=booth-01");
    expect(missing.status).toBe(401);

    const cookie = operatorCookie();
    const got = await app.request("/v1/system/current?boothId=booth-01", { headers: { cookie } });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({
      boothId: "booth-01",
      snapshot: sampleSnapshot,
    });

    const notFound = await app.request("/v1/system/current?boothId=other", { headers: { cookie } });
    expect(notFound.status).toBe(404);

    const list = await app.request("/v1/system/current", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ items: [{ boothId: "booth-01" }] });
  });

  it("preserves runtimeMode on the snapshot through cache + GET", async () => {
    const app = createApp();
    const put = await app.request("/v1/system", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({
        boothId: "booth-01",
        snapshot: { ...sampleSnapshot, runtimeMode: "simulator" },
      }),
    });
    expect(put.status).toBe(204);

    const cookie = operatorCookie();
    const got = await app.request("/v1/system/current?boothId=booth-01", { headers: { cookie } });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({
      boothId: "booth-01",
      snapshot: { runtimeMode: "simulator" },
    });
  });

  it("echoes the booth client version through cache + GET", async () => {
    const app = createApp();
    const put = await app.request("/v1/system", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({
        boothId: "booth-01",
        snapshot: sampleSnapshot,
        version: "0.3.2",
      }),
    });
    expect(put.status).toBe(204);

    const cookie = operatorCookie();
    const got = await app.request("/v1/system/current?boothId=booth-01", { headers: { cookie } });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({
      boothId: "booth-01",
      snapshot: sampleSnapshot,
      version: "0.3.2",
    });
  });
});
