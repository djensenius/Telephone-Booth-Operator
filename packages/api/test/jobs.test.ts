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
import { fakeDb, resetFakeDb, seedMessage, store } from "./support/fake-db.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  process.env.TRANSLATION_PROVIDER = "disabled";
  process.env.AUTO_DECISION_MODE = "always_pending";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const apiHeaders = {
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

const seedPendingTranscription = async (
  overrides: { language?: string | null; status?: "pending" | "succeeded" | "failed" } = {},
) => {
  const message = seedMessage({ status: "received" });
  const row = await fakeDb.transcription.create({
    data: {
      messageId: message.id,
      provider: "mac_app",
      status: overrides.status ?? "pending",
      language: overrides.language ?? null,
    },
  });
  return { message, row };
};

const seedPendingModeration = async (overrides: { transcriptionId?: string | null } = {}) => {
  const message = seedMessage({ status: "pending" });
  const row = await fakeDb.moderation.create({
    data: {
      messageId: message.id,
      transcriptionId: overrides.transcriptionId ?? null,
      provider: "mac_app",
      status: "pending",
    },
  });
  return { message, row };
};

describe("/v1/jobs", () => {
  beforeEach(setup);

  it("requires an API token", async () => {
    const app = createApp();
    const res = await app.request("/v1/jobs/next", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 204 when there is nothing pending", async () => {
    const app = createApp();
    const res = await app.request("/v1/jobs/next", { headers: apiHeaders });
    expect(res.status).toBe(204);
  });

  it("does NOT go through requireOperator (operator-session middleware)", async () => {
    // A bearer-only request reaches the jobs router even though `/v1/*` is
    // wrapped in requireOperator() — the jobs route must be mounted earlier.
    const app = createApp();
    const res = await app.request("/v1/jobs/next", { headers: apiHeaders });
    expect(res.status).toBe(204); // 204, not 401 from requireOperator.
  });

  it("claims and returns a transcription job", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription();
    const res = await app.request("/v1/jobs/next", { headers: apiHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("transcription");
    expect(body.id).toBe(`transcription-${row.id}`);
    expect(typeof body.leaseToken).toBe("string");
    expect(body.transcription.audioUrl).toMatch(/^https:\/\//);

    // attemptCount bumped, lease columns set.
    const after = store.transcriptions.get(row.id)!;
    expect(after.attemptCount).toBe(1);
    expect(after.leaseToken).toBe(body.leaseToken);
    expect(after.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it("two concurrent /next calls do not double-claim the same row", async () => {
    const app = createApp();
    await seedPendingTranscription();
    const [a, b] = await Promise.all([
      app.request("/v1/jobs/next", { headers: apiHeaders }),
      app.request("/v1/jobs/next", { headers: apiHeaders }),
    ]);
    // One claims, one gets 204. (With one pending row we can't get two 200s.)
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 204]);
  });

  it("transcription /succeed creates a pending moderation row (English audio)", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription({ language: "en" });
    const next = await app.request("/v1/jobs/next", { headers: apiHeaders });
    const { leaseToken } = await next.json();
    const ok = await app.request(`/v1/jobs/transcription-${row.id}/succeed`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ leaseToken, text: "hello world", language: "en" }),
    });
    expect(ok.status).toBe(200);

    const moderations = [...store.moderations.values()];
    expect(moderations).toHaveLength(1);
    expect(moderations[0].status).toBe("pending");
    expect(moderations[0].transcriptionId).toBe(row.id);

    // English: no translation enqueued.
    const after = store.transcriptions.get(row.id)!;
    expect(after.translationStatus).toBeNull();
  });

  it("transcription /succeed marks translation pending for non-English", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription({ language: "fr" });
    const next = await app.request("/v1/jobs/next", { headers: apiHeaders });
    const { leaseToken } = await next.json();
    await app.request(`/v1/jobs/transcription-${row.id}/succeed`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ leaseToken, text: "bonjour", language: "fr" }),
    });
    const after = store.transcriptions.get(row.id)!;
    expect(after.translationStatus).toBe("pending");
  });

  it("moderation is NOT claimable while linked transcription has translation pending", async () => {
    const app = createApp();
    // Set up a transcription that succeeded and is still awaiting translation,
    // plus a pending moderation row pointing at it.
    const { row: trans } = await seedPendingTranscription({
      language: "fr",
      status: "succeeded",
    });
    await fakeDb.transcription.update({
      where: { id: trans.id },
      data: { translationStatus: "pending", text: "bonjour" },
    });
    await seedPendingModeration({ transcriptionId: trans.id });

    const res = await app.request("/v1/jobs/next?kinds=moderation", { headers: apiHeaders });
    expect(res.status).toBe(204);

    // Once translation succeeds, moderation becomes claimable.
    await fakeDb.transcription.update({
      where: { id: trans.id },
      data: { translationStatus: "succeeded", translatedText: "hello" },
    });
    const next = await app.request("/v1/jobs/next?kinds=moderation", { headers: apiHeaders });
    expect(next.status).toBe(200);
    const body = await next.json();
    expect(body.kind).toBe("moderation");
    expect(body.moderation.text).toBe("hello"); // prefers translated text
  });

  it("/succeed with a stale leaseToken returns 409 and does not mutate the row", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription({ language: "en" });
    const next = await app.request("/v1/jobs/next", { headers: apiHeaders });
    const { leaseToken } = await next.json();

    // Simulate the row being re-leased by someone else.
    await fakeDb.transcription.update({
      where: { id: row.id },
      data: { leaseToken: "other-worker-token" },
    });

    const stale = await app.request(`/v1/jobs/transcription-${row.id}/succeed`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ leaseToken, text: "ghost write", language: "en" }),
    });
    expect(stale.status).toBe(409);
    const after = store.transcriptions.get(row.id)!;
    expect(after.status).toBe("pending");
    expect(after.text).toBeNull();
  });

  it("/fail bumps attemptCount and marks terminal at the cap", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription();
    // Manually push attemptCount near the cap to avoid 5 round-trips in test.
    await fakeDb.transcription.update({
      where: { id: row.id },
      data: { attemptCount: 4 },
    });
    const next = await app.request("/v1/jobs/next", { headers: apiHeaders });
    const { leaseToken } = await next.json();

    const fail = await app.request(`/v1/jobs/transcription-${row.id}/fail`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ leaseToken, errorCode: "upstream_unavailable" }),
    });
    expect(fail.status).toBe(200);
    const body = await fail.json();
    expect(body.terminal).toBe(true);
    const after = store.transcriptions.get(row.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/upstream_unavailable/);
  });

  it("/heartbeat with wrong leaseToken returns 409", async () => {
    const app = createApp();
    const { row } = await seedPendingTranscription();
    await app.request("/v1/jobs/next", { headers: apiHeaders });
    const bad = await app.request(`/v1/jobs/transcription-${row.id}/heartbeat`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ leaseToken: "not-mine", leaseSeconds: 60 }),
    });
    expect(bad.status).toBe(409);
  });

  it("translation /succeed writes translated text and clears the lease", async () => {
    const app = createApp();
    const { row: trans } = await seedPendingTranscription({
      language: "fr",
      status: "succeeded",
    });
    await fakeDb.transcription.update({
      where: { id: trans.id },
      data: { translationStatus: "pending", text: "bonjour" },
    });
    const next = await app.request("/v1/jobs/next?kinds=translation", { headers: apiHeaders });
    expect(next.status).toBe(200);
    const { leaseToken } = await next.json();
    const ok = await app.request(`/v1/jobs/translation-${trans.id}/succeed`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({
        leaseToken,
        translatedText: "hello",
        sourceLanguage: "fr",
        targetLanguage: "en",
      }),
    });
    expect(ok.status).toBe(200);
    const after = store.transcriptions.get(trans.id)!;
    expect(after.translationStatus).toBe("succeeded");
    expect(after.translatedText).toBe("hello");
    expect(after.translationLeaseToken).toBeNull();
  });
});
