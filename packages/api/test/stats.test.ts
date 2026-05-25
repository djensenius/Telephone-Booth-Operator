import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

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
import { __setBearerVerifierForTests, resetBearerAuthForTests } from "../src/lib/bearer-auth.js";
import { resetAuthConfigForTests } from "../src/lib/config.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetStatsCacheForTests } from "../src/routes/stats.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import {
  resetFakeDb,
  seedFile,
  seedQuestion,
  seedMessage,
  seedStatus,
  seedCallSession,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const BEARER_CLAIMS = {
  iss: "https://idp.example",
  sub: "mobile-user-1",
  aud: "mobile-client",
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "operator@example.com",
  name: "Mobile Operator",
  groups: ["operators"],
};

const setupEnv = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.OIDC_ISSUER = "https://idp.example";
  process.env.OIDC_CLIENT_ID = "client-id";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
  process.env.OIDC_ALLOWED_GROUPS = "operators";
  process.env.OIDC_MOBILE_AUDIENCES = "mobile-client";
  delete process.env.AUTH_DISABLED;
  resetAuthConfigForTests();
  resetBearerAuthForTests();
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetStatsCacheForTests();
};

const installValidBearer = () => {
  __setBearerVerifierForTests({
    jwks: () => ({ kid: "test-key" }) as unknown as never,
    jwtVerify: (async () => ({
      payload: BEARER_CLAIMS,
    })) as unknown as typeof import("jose").jwtVerify,
  });
};

describe("/v1/stats/summary", () => {
  beforeEach(() => {
    setupEnv();
  });

  it("returns a 401 with no auth", async () => {
    const app = createApp();
    const res = await app.request("/v1/stats/summary");
    expect(res.status).toBe(401);
  });

  it("aggregates booth status, message counts, and call counts", async () => {
    const app = createApp();
    installValidBearer();

    // Seed: 2 pending messages, 1 received today, 1 call today, 1 in-progress call
    const audioA = seedFile({ sha256: "a".repeat(64), blobKey: "messages/aa/messageA.flac" });
    const audioB = seedFile({ sha256: "b".repeat(64), blobKey: "messages/bb/messageB.flac" });
    const audioC = seedFile({ sha256: "c".repeat(64), blobKey: "messages/cc/messageC.flac" });
    const audioQ = seedFile({ sha256: "d".repeat(64), blobKey: "questions/dd/q.flac" });
    const question = seedQuestion({ audioId: audioQ.id });
    seedMessage({ audioId: audioA.id, status: "pending", questionId: question.id });
    seedMessage({ audioId: audioB.id, status: "pending", questionId: question.id });
    seedMessage({ audioId: audioC.id, status: "approved", questionId: question.id });
    seedStatus({ state: "idle" });
    seedCallSession({ endedAt: new Date() });
    seedCallSession({ endedAt: null });

    const res = await app.request("/v1/stats/summary", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      booth: { state: string };
      messages: { pending: number; receivedToday: number; latestId: string | null };
      calls: { today: number; inProgress: number };
      realtime: { wsClients: number };
      generatedAt: string;
    };
    expect(body.booth.state).toBe("idle");
    expect(body.messages.pending).toBe(2);
    expect(body.messages.receivedToday).toBe(3);
    expect(body.messages.latestId).not.toBeNull();
    expect(body.calls.today).toBe(2);
    expect(body.calls.inProgress).toBe(1);
    expect(body.realtime.wsClients).toBe(0);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("memoizes the response for the configured TTL", async () => {
    const app = createApp();
    installValidBearer();

    seedStatus({ state: "idle" });
    const first = await app.request("/v1/stats/summary", {
      headers: { authorization: "Bearer good-token" },
    });
    const firstBody = (await first.json()) as { generatedAt: string };

    // Mutate underlying data after the first request — cache should hide it
    seedStatus({ state: "recording" });
    const second = await app.request("/v1/stats/summary", {
      headers: { authorization: "Bearer good-token" },
    });
    const secondBody = (await second.json()) as { generatedAt: string; booth: { state: string } };

    expect(secondBody.generatedAt).toBe(firstBody.generatedAt);
    expect(secondBody.booth.state).toBe("idle");
  });

  it("accepts a cookie-authenticated browser session", async () => {
    const app = createApp();
    seedStatus({ state: "idle" });
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/summary", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("/v1/auth/me also resolves via a bearer token", async () => {
    const app = createApp();
    installValidBearer();
    const res = await app.request("/v1/auth/me", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.id).toBe("mobile-user-1");
    expect(body.email).toBe("operator@example.com");
  });

  it("phone-side public endpoints still bypass bearer enforcement", async () => {
    const app = createApp();
    // No bearer header → public phone route is reachable by the booth even
    // though `requireOperator()` is mounted globally on `/v1/*`.
    const res = await app.request("/v1/status");
    expect(res.status).toBe(200);
  });
});
