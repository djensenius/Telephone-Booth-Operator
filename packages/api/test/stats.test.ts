import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  seedBoothEvent,
  seedInstallation,
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

const ORIGINAL_PROCESS_TIME_ZONE = process.env.TZ;

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

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_PROCESS_TIME_ZONE === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_PROCESS_TIME_ZONE;
  });

  it("returns a 401 with no auth", async () => {
    const app = createApp();
    const res = await app.request("/v1/stats/summary");
    expect(res.status).toBe(401);
  });

  it("aggregates booth status, message counts, and call counts", async () => {
    const app = createApp();
    installValidBearer();

    // Seed: 2 pending + 1 received (awaiting moderation) + 1 approved message,
    // all created today, plus 1 call today and 1 in-progress call.
    const audioA = seedFile({ sha256: "a".repeat(64), blobKey: "messages/aa/messageA.flac" });
    const audioB = seedFile({ sha256: "b".repeat(64), blobKey: "messages/bb/messageB.flac" });
    const audioC = seedFile({ sha256: "c".repeat(64), blobKey: "messages/cc/messageC.flac" });
    const audioD = seedFile({ sha256: "e".repeat(64), blobKey: "messages/ee/messageD.flac" });
    const audioQ = seedFile({ sha256: "d".repeat(64), blobKey: "questions/dd/q.flac" });
    const question = seedQuestion({ audioId: audioQ.id });
    seedMessage({ audioId: audioA.id, status: "pending", questionId: question.id });
    seedMessage({ audioId: audioB.id, status: "pending", questionId: question.id });
    seedMessage({ audioId: audioC.id, status: "approved", questionId: question.id });
    seedMessage({ audioId: audioD.id, status: "received", questionId: question.id });
    seedStatus({ state: "idle" });
    seedCallSession({ endedAt: new Date() });
    seedCallSession({ endedAt: null });

    const res = await app.request("/v1/stats/summary", {
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      booth: { state: string };
      messages: {
        pending: number;
        awaitingModeration: number;
        receivedToday: number;
        availableToday: number;
        latestId: string | null;
      };
      actions: { messagePlaybackStarts: number };
      interactions: { today: number; inProgress: number };
      calls: { today: number; inProgress: number };
      realtime: { wsClients: number };
      dayStartedAt: string;
      generatedAt: string;
      timeZone: string;
    };
    expect(body.booth.state).toBe("idle");
    expect(body.messages.pending).toBe(2);
    expect(body.messages.awaitingModeration).toBe(3);
    expect(body.messages.receivedToday).toBe(4);
    expect(body.messages.availableToday).toBe(4);
    expect(body.actions.messagePlaybackStarts).toBe(0);
    expect(body.messages.latestId).not.toBeNull();
    expect(body.interactions.today).toBe(2);
    expect(body.interactions.inProgress).toBe(1);
    expect(body.calls.today).toBe(2);
    expect(body.calls.inProgress).toBe(1);
    expect(body.realtime.wsClients).toBe(0);
    expect(typeof body.dayStartedAt).toBe("string");
    expect(typeof body.generatedAt).toBe("string");
    expect(body.timeZone).toBe("America/Toronto");
  });

  it.each([
    {
      season: "EDT",
      now: "2026-08-08T19:00:00.000Z",
      beforeMidnight: "2026-08-08T03:59:59.999Z",
      midnight: "2026-08-08T04:00:00.000Z",
    },
    {
      season: "EST",
      now: "2026-01-08T19:00:00.000Z",
      beforeMidnight: "2026-01-08T04:59:59.999Z",
      midnight: "2026-01-08T05:00:00.000Z",
    },
  ])(
    "uses Toronto midnight for today counters during $season",
    async ({ now, beforeMidnight, midnight }) => {
      process.env.TZ = "UTC";
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      seedMessage({ createdAt: new Date(beforeMidnight) });
      seedMessage({ createdAt: new Date(midnight) });
      seedCallSession({ startedAt: new Date(beforeMidnight) });
      seedCallSession({ startedAt: new Date(midnight) });

      const response = await createApp().request("/v1/stats/summary", {
        headers: { cookie: operatorCookie() },
      });

      expect(response.status, await response.clone().text()).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        messages: { receivedToday: 1 },
        interactions: { today: 1 },
        calls: { today: 1 },
        dayStartedAt: midnight,
        generatedAt: now,
        timeZone: "America/Toronto",
      });
    },
  );

  it("keeps summaries for different time zones in separate cache entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T19:00:00.000Z"));
    seedMessage({ createdAt: new Date("2026-08-08T02:00:00.000Z") });
    seedCallSession({ startedAt: new Date("2026-08-08T02:00:00.000Z") });
    const app = createApp();
    const headers = { cookie: operatorCookie() };

    const toronto = await app.request("/v1/stats/summary?timeZone=America%2FToronto", {
      headers,
    });
    const utc = await app.request("/v1/stats/summary?timeZone=UTC", {
      headers,
    });

    await expect(toronto.json()).resolves.toMatchObject({
      messages: { receivedToday: 0 },
      interactions: { today: 0 },
      calls: { today: 0 },
      dayStartedAt: "2026-08-08T04:00:00.000Z",
      timeZone: "America/Toronto",
    });
    await expect(utc.json()).resolves.toMatchObject({
      messages: { receivedToday: 1 },
      interactions: { today: 1 },
      calls: { today: 1 },
      dayStartedAt: "2026-08-08T00:00:00.000Z",
      timeZone: "UTC",
    });
  });

  it("keeps receivedToday raw while availableToday excludes rejected messages", async () => {
    const app = createApp();
    seedMessage({ status: "received" });
    seedMessage({ status: "pending" });
    seedMessage({ status: "approved" });
    seedMessage({ status: "rejected" });

    const response = await app.request("/v1/stats/summary", {
      headers: { cookie: operatorCookie() },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: { receivedToday: 4, availableToday: 3 },
    });
  });

  it("counts message playback transitions, not digit selections, by local day and installation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T19:00:00.000Z"));
    const otherInstallation = seedInstallation({
      id: "22222222-2222-4222-8222-222222222222",
    });
    seedBoothEvent({ type: "digit_dialed", payload: { digit: 2 } });
    seedBoothEvent({ type: "state_transition", payload: { to: "playing_message" } });
    seedBoothEvent({ type: "state_transition", payload: { to: "playing_instructions" } });
    seedBoothEvent({
      type: "state_transition",
      payload: { to: "playing_message" },
      occurredAt: new Date("2026-08-08T03:59:59.999Z"),
    });
    seedBoothEvent({
      type: "state_transition",
      payload: { to: "playing_message" },
      installationId: otherInstallation.id,
    });

    const response = await createApp().request(
      `/v1/stats/summary?installationId=${otherInstallation.id}&timeZone=America%2FToronto`,
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actions: { messagePlaybackStarts: 1 },
      dayStartedAt: "2026-08-08T04:00:00.000Z",
      timeZone: "America/Toronto",
    });

    const activeResponse = await createApp().request(
      "/v1/stats/summary?timeZone=America%2FToronto",
      { headers: { cookie: operatorCookie() } },
    );
    await expect(activeResponse.json()).resolves.toMatchObject({
      actions: { messagePlaybackStarts: 1 },
    });
  });

  it("invalidates cached summaries after a decision and a hard deletion", async () => {
    const app = createApp();
    const decided = seedMessage({ status: "pending" });
    const deleted = seedMessage({ status: "approved" });
    const headers = { cookie: operatorCookie() };

    const first = await app.request("/v1/stats/summary", { headers });
    await expect(first.json()).resolves.toMatchObject({
      messages: { receivedToday: 2, availableToday: 2 },
    });

    const decision = await app.request(`/v1/messages/${decided.id}/decision`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(decision.status).toBe(200);
    const afterDecision = await app.request("/v1/stats/summary", { headers });
    await expect(afterDecision.json()).resolves.toMatchObject({
      messages: { receivedToday: 2, availableToday: 1 },
    });

    const deletion = await app.request(`/v1/messages/${deleted.id}`, {
      method: "DELETE",
      headers,
    });
    expect(deletion.status).toBe(204);
    const afterDeletion = await app.request("/v1/stats/summary", { headers });
    await expect(afterDeletion.json()).resolves.toMatchObject({
      messages: { receivedToday: 1, availableToday: 0 },
    });
  });

  it("rotates the cache immediately at local midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T03:59:59.500Z"));
    seedMessage({ createdAt: new Date("2026-08-08T03:59:59.500Z") });
    const app = createApp();
    const headers = { cookie: operatorCookie() };

    const beforeMidnight = await app.request("/v1/stats/summary", {
      headers,
    });
    await expect(beforeMidnight.json()).resolves.toMatchObject({
      messages: { receivedToday: 1 },
      interactions: { today: 0 },
      dayStartedAt: "2026-08-07T04:00:00.000Z",
    });

    vi.setSystemTime(new Date("2026-08-08T04:00:00.000Z"));
    const afterMidnight = await app.request("/v1/stats/summary", {
      headers,
    });
    await expect(afterMidnight.json()).resolves.toMatchObject({
      messages: { receivedToday: 0 },
      interactions: { today: 0 },
      dayStartedAt: "2026-08-08T04:00:00.000Z",
    });
  });

  it("rejects an unknown IANA time zone", async () => {
    const response = await createApp().request("/v1/stats/summary?timeZone=Telephone%2FBooth", {
      headers: { cookie: operatorCookie() },
    });
    expect(response.status).toBe(400);
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

  it("requires authentication for GET /v1/status", async () => {
    const app = createApp();
    seedStatus({ state: "idle" });

    // GET /v1/status is no longer public: an unauthenticated read is rejected
    // even though `requireOperator()` bypasses it at the global layer (the
    // per-route guard enforces operator-or-API-token auth).
    const anon = await app.request("/v1/status");
    expect(anon.status).toBe(401);

    // An operator session (cookie) can read the snapshot.
    const res = await app.request("/v1/status", { headers: { cookie: operatorCookie() } });
    expect(res.status).toBe(200);
  });
});
