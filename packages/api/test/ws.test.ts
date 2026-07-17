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

vi.mock("../src/lib/oidc.js", () => ({
  getOidcClient: vi.fn(async () => ({
    serverMetadata: () => ({ jwks_uri: "https://idp.example/jwks.json" }),
  })),
  refreshTokens: vi.fn(),
  exchangeCode: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  endSessionUrl: vi.fn(),
}));

import { createApp } from "../src/index.js";
import {
  __setBearerVerifierForTests,
  resetBearerAuthForTests,
} from "../src/lib/bearer-auth.js";
import { resetAuthConfigForTests } from "../src/lib/config.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { attachStatusWebSocket } from "../src/routes/ws.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.OIDC_ISSUER = "https://idp.example";
  process.env.OIDC_CLIENT_ID = "client-id";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
  process.env.OIDC_ALLOWED_GROUPS = "operators";
  process.env.OIDC_MOBILE_AUDIENCES = "mobile-client";
  delete process.env.OIDC_MOBILE_ISSUERS;
  delete process.env.OIDC_ALLOWED_EMAILS;
  delete process.env.AUTH_DISABLED;
  resetSessionCryptoForTests();
  resetAuthConfigForTests();
  resetBearerAuthForTests();
  resetFakeDb();
  resetFakeAzure();
};

const OPERATOR_CLAIMS = {
  iss: "https://idp.example",
  sub: "bearer-operator-1",
  aud: "mobile-client",
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "operator@example.com",
  name: "Bearer Operator",
  groups: ["operators"],
};

// Injects a fake JWKS + JWT verifier so `verifyOperatorBearer` accepts the
// bearer token `"good"` and rejects anything else, with no live Authentik.
const installBearerVerifier = (): void => {
  __setBearerVerifierForTests({
    jwks: () => ({}) as unknown as never,
    jwtVerify: (async (token: string) => {
      if (token !== "good") {
        const { errors } = await import("jose");
        throw new errors.JWSInvalid("bad token");
      }
      return { payload: OPERATOR_CLAIMS };
    }) as unknown as typeof import("jose").jwtVerify,
  });
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

  it("broadcasts status updates to bearer-authenticated clients", async () => {
    installBearerVerifier();
    const app = createApp();
    const server = serve({ fetch: app.fetch, port: 0 });
    attachStatusWebSocket(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws/status`, {
      headers: { authorization: "Bearer good" },
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
      body: JSON.stringify({ state: "recording" }),
    });
    expect(put.status).toBe(204);

    await expect(message).resolves.toMatchObject({
      kind: "status",
      status: { state: "recording" },
    });
    ws.close();
    await closeServer(server);
  });

  it("closes invalid-bearer clients with 1008", async () => {
    installBearerVerifier();
    const app = createApp();
    const server = serve({ fetch: app.fetch, port: 0 });
    attachStatusWebSocket(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws/status`, {
        headers: { authorization: "Bearer nope" },
      });
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(code).toBe(1008);
    await closeServer(server);
  });
});
