import { serve } from "@hono/node-server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

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
import { attachStatusWebSocket } from "../src/routes/ws.js";
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

const closeServer = async (server: ReturnType<typeof serve>): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

describe("status websocket", () => {
  beforeEach(setup);

  it("closes missing-cookie clients with 1008", async () => {
    const app = createApp();
    const server = serve({ fetch: app.fetch, port: 0 });
    attachStatusWebSocket(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws/status`);
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(code).toBe(1008);
    await closeServer(server);
  });

  it("broadcasts status updates to cookie-authenticated clients", async () => {
    const app = createApp();
    const server = serve({ fetch: app.fetch, port: 0 });
    attachStatusWebSocket(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws/status`, {
      headers: { cookie: operatorCookie() },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const message = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
    });
    const put = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ state: "playingQuestion" }),
    });
    expect(put.status).toBe(204);

    await expect(message).resolves.toMatchObject({
      kind: "status",
      status: { state: "playingQuestion" },
    });
    ws.close();
    await closeServer(server);
  });
});
