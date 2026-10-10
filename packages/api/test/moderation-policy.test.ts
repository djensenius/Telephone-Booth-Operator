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
import { resetFakeDb, store } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

describe("moderation policy routes", () => {
  beforeEach(setup);

  it("returns the bundled fallback when no editable policy exists", async () => {
    const app = createApp();
    const res = await app.request("/v1/moderation-policy", {
      headers: { cookie: operatorCookie() },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ key: "default", version: 0, source: "fallback" });
    expect(body.instructions).toContain("public art installation");
  });

  it("requires admin access to update the policy and records an audit entry", async () => {
    const app = createApp();
    const instructions = `${"Review public booth transcripts. ".repeat(4)}Never recommend approval for slurs or profanity.`;

    const forbidden = await app.request("/v1/admin/moderation-policy", {
      method: "PUT",
      headers: { cookie: operatorCookie({ isAdmin: false }), "content-type": "application/json" },
      body: JSON.stringify({ instructions }),
    });
    expect(forbidden.status).toBe(403);

    const updated = await app.request("/v1/admin/moderation-policy", {
      method: "PUT",
      headers: { cookie: operatorCookie({ isAdmin: true }), "content-type": "application/json" },
      body: JSON.stringify({ instructions }),
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const body = await updated.json();
    expect(body).toMatchObject({ key: "default", version: 1, source: "server", instructions });

    const current = await app.request("/v1/moderation-policy", {
      headers: { cookie: operatorCookie() },
    });
    expect(await current.json()).toMatchObject({ version: 1, source: "server", instructions });
    expect(store.auditLogs.some((row) => row.action === "moderationPolicy.update")).toBe(true);
  });
});
