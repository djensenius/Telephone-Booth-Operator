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
import { wsBroadcaster, type WsEnvelope } from "../src/lib/broadcaster.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { fakeDb, resetFakeDb, seedFile, seedMessage, store } from "./support/fake-db.js";
import { phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  process.env.TRANSLATION_PROVIDER = "disabled";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

// Capture every envelope the router broadcasts during a test.
const captureEnvelopes = (): { events: WsEnvelope[]; stop: () => void } => {
  const events: WsEnvelope[] = [];
  const clientId = `test-${Math.random()}`;
  wsBroadcaster.subscribe(clientId, (e) => events.push(e));
  return { events, stop: () => wsBroadcaster.unsubscribe(clientId) };
};

const postJson = (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers = phoneHeaders,
) =>
  app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const seedPendingTranscription = (messageId: string) =>
  fakeDb.transcription.create({
    data: {
      messageId,
      provider: "push",
      model: null,
      status: "pending",
      requestedById: null,
    },
  });

describe("worker push-back callbacks", () => {
  beforeEach(setup);

  it("rejects callbacks without a valid API token", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const res = await postJson(
      app,
      `/v1/worker/messages/${message.id}/transcription`,
      { text: "hello" },
      { authorization: "nope" },
    );
    expect(res.status).toBe(401);
  });

  it("rejects malformed transcription snapshot IDs", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: "not-a-uuid",
      expectedLatestTranscriptionId: "also-not-a-uuid",
      text: "hello",
    });

    expect(res.status).toBe(400);
  });

  it("rejects a transcription callback when a newer result already landed", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    await fakeDb.transcription.create({
      data: {
        messageId: message.id,
        provider: "on_device",
        status: "succeeded",
        text: "newer result",
        completedAt: new Date(),
      },
    });

    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      expectedLatestTranscriptionId: null,
      text: "stale worker result",
      language: "en",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_transcription" });
  });

  it("rejects a second targeted callback after its pending row was finalized", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);

    const first = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "first worker result",
      language: "en",
    });
    expect(first.status).toBe(200);

    const second = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "stale second result",
      language: "en",
    });

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "stale_transcription" });
    expect([...store.transcriptions.values()].filter((row) => row.messageId === message.id))
      .toHaveLength(1);
  });

  it("stores an English transcription and broadcasts moderation work", async () => {
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);
    const cap = captureEnvelopes();

    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "hello there",
      language: "en",
    });
    cap.stop();

    expect(res.status).toBe(200);
    const transcriptions = [...store.transcriptions.values()].filter(
      (t) => t.messageId === message.id,
    );
    expect(transcriptions).toHaveLength(1);
    expect(transcriptions[0]?.status).toBe("succeeded");
    expect(transcriptions[0]?.text).toBe("hello there");
    // A pending moderation row was created for the human-review pipeline.
    const moderations = [...store.moderations.values()].filter((m) => m.messageId === message.id);
    expect(moderations).toHaveLength(1);
    expect(moderations[0]?.status).toBe("pending");
    // English text needs no translation → moderation work is requested.
    const work = cap.events.find((e) => e.kind === "work");
    expect(work).toEqual({ kind: "work", messageId: message.id, needs: ["moderation"] });
  });

  it("requests translation work first for non-English audio", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);
    const cap = captureEnvelopes();

    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "bonjour",
      language: "fr",
    });
    cap.stop();

    expect(res.status).toBe(200);
    const transcription = [...store.transcriptions.values()].find(
      (t) => t.messageId === message.id,
    );
    expect(transcription?.translationStatus).toBe("pending");
    const work = cap.events.find((e) => e.kind === "work");
    expect(work).toEqual({ kind: "work", messageId: message.id, needs: ["translation"] });
  });

  it("advances a silent (empty) recording without creating moderation work", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);
    const cap = captureEnvelopes();

    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "   ",
    });
    cap.stop();

    expect(res.status).toBe(200);
    expect(store.messages.get(message.id)?.status).toBe("pending");
    expect([...store.moderations.values()]).toHaveLength(0);
    expect(cap.events.some((e) => e.kind === "work")).toBe(false);
  });

  it("records an unsolicited transcription when no pending row was requested", async () => {
    // Transcription is push-only and optional: the app decides when to
    // transcribe, so the API never pre-creates a pending row. The result must
    // still land instead of being dropped.
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const audio = seedFile({ sha256: "9".repeat(64), durationMs: 7777 });
    const message = seedMessage({ status: "pending", audioId: audio.id });
    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      text: "unsolicited transcript",
      language: "en",
      model: "parakeet",
    });

    expect(res.status).toBe(200);
    const rows = [...store.transcriptions.values()].filter((t) => t.messageId === message.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "push",
      model: "parakeet",
      status: "succeeded",
      text: "unsolicited transcript",
      language: "en",
      // Copied from the message audio so the row carries the same metadata a
      // solicited (pre-created) row would have.
      durationMs: 7777,
    });
    // English text still flows on to the push moderation step.
    expect([...store.moderations.values()].filter((m) => m.messageId === message.id)).toHaveLength(
      1,
    );
  });

  it("rejects an ID-less callback when a pending row exists", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    await seedPendingTranscription(message.id);

    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      text: "legacy stale result",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_transcription" });
  });

  it("is idempotent when an unsolicited transcription is redelivered", async () => {
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "pending" });
    const body = { text: "retried transcript", language: "en" };

    const first = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, body);
    const second = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // A redelivery must not duplicate history or re-run downstream work.
    expect(
      [...store.transcriptions.values()].filter((t) => t.messageId === message.id),
    ).toHaveLength(1);
    expect([...store.moderations.values()].filter((m) => m.messageId === message.id)).toHaveLength(
      1,
    );
  });

  it("records a genuinely different unsolicited transcript as a new attempt", async () => {
    const app = createApp();
    const message = seedMessage({ status: "pending" });

    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, { text: "first pass" });
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, { text: "second pass" });

    const rows = [...store.transcriptions.values()].filter((t) => t.messageId === message.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.text)).toEqual(expect.arrayContaining(["first pass", "second pass"]));
  });

  it("records a corrected language for the same text as a new attempt", async () => {
    const app = createApp();
    const message = seedMessage({ status: "pending" });

    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, { text: "bonjour" });
    // Same text, but now tagged as French — translation depends on it, so this
    // is a correction rather than a redelivery.
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      text: "bonjour",
      language: "fr",
    });

    const rows = [...store.transcriptions.values()].filter((t) => t.messageId === message.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.language ?? null)).toEqual(expect.arrayContaining([null, "fr"]));
  });

  it("uses provider-aware routing after transcription instead of always pushing work", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const seeded = await fakeDb.transcription.create({
      data: {
        messageId: message.id,
        provider: "push",
        model: null,
        status: "pending",
        requestedById: null,
      },
    });
    const cap = captureEnvelopes();
    const res = await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: seeded.id,
      text: "hello there",
      language: "en",
    });
    cap.stop();

    expect(res.status).toBe(200);
    expect(store.transcriptions.get(seeded.id)?.status).toBe("succeeded");
    expect([...store.moderations.values()].filter((m) => m.messageId === message.id)).toMatchObject(
      [{ status: "failed", provider: "disabled" }],
    );
    expect(cap.events.some((e) => e.kind === "work")).toBe(false);
  });

  it("stores a translation and then requests moderation work", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const transcriptionPending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: transcriptionPending.id,
      text: "bonjour",
      language: "fr",
    });
    const transcription = [...store.transcriptions.values()].find(
      (t) => t.messageId === message.id,
    );
    const cap = captureEnvelopes();

    const res = await postJson(app, `/v1/worker/messages/${message.id}/translation`, {
      transcriptionId: transcription?.id,
      translatedText: "hello",
      sourceLanguage: "fr",
      targetLanguage: "en",
    });
    cap.stop();

    expect(res.status).toBe(200);
    const updated = store.transcriptions.get(transcription?.id ?? "");
    expect(updated?.translationStatus).toBe("succeeded");
    expect(updated?.translatedText).toBe("hello");
    const work = cap.events.find((e) => e.kind === "work");
    expect(work).toEqual({ kind: "work", messageId: message.id, needs: ["moderation"] });
  });

  it("does not rerun downstream moderation for duplicate translation callbacks", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const transcriptionPending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: transcriptionPending.id,
      text: "bonjour",
      language: "fr",
    });
    const transcription = [...store.transcriptions.values()].find(
      (t) => t.messageId === message.id,
    );
    await postJson(app, `/v1/worker/messages/${message.id}/translation`, {
      transcriptionId: transcription?.id,
      translatedText: "hello",
      targetLanguage: "en",
    });
    const cap = captureEnvelopes();
    const duplicate = await postJson(app, `/v1/worker/messages/${message.id}/translation`, {
      transcriptionId: transcription?.id,
      translatedText: "stale hello",
      targetLanguage: "en",
    });
    cap.stop();

    expect(duplicate.status).toBe(200);
    expect(store.transcriptions.get(transcription?.id ?? "")?.translatedText).toBe("hello");
    expect([...store.moderations.values()].filter((m) => m.messageId === message.id)).toHaveLength(
      1,
    );
    expect(cap.events.some((e) => e.kind === "work")).toBe(false);
  });

  it("records the moderation suggestion and surfaces the message without deciding it", async () => {
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "hello there",
      language: "en",
    });
    const moderation = [...store.moderations.values()].find((m) => m.messageId === message.id);
    const work = await app.request(`/v1/worker/messages/${message.id}/work`, {
      headers: phoneHeaders,
    });
    const workBody = (await work.json()) as {
      transcription: { moderationInputSha256: string } | null;
    };

    const res = await postJson(app, `/v1/worker/messages/${message.id}/moderation`, {
      transcriptionId: moderation?.transcriptionId,
      inputSha256: workBody.transcription?.moderationInputSha256,
      flagged: true,
      recommendation: "reject",
      maxScore: 0.92,
      reasonSummary: "abusive language",
    });

    expect(res.status).toBe(200);
    const stored = store.moderations.get(moderation?.id ?? "");
    expect(stored?.status).toBe("succeeded");
    expect(stored?.recommendation).toBe("reject");
    expect(stored?.flagged).toBe(true);
    // Advisory only: the message is surfaced for review, never auto-decided.
    const finalMessage = store.messages.get(message.id);
    expect(finalMessage?.status).toBe("pending");
    expect(finalMessage?.decidedAt ?? null).toBeNull();
  });

  it("rejects an ID-less moderation callback for a transcription-scoped row", async () => {
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const pending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "hello there",
      language: "en",
    });

    const res = await postJson(app, `/v1/worker/messages/${message.id}/moderation`, {
      flagged: false,
      recommendation: "approve",
      maxScore: 0.02,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_transcription" });
  });

  it("does not create moderation rows for an unknown transcription", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const res = await postJson(app, `/v1/worker/messages/${message.id}/moderation`, {
      transcriptionId: "00000000-0000-4000-8000-000000000099",
      inputSha256: "0".repeat(64),
      flagged: false,
      recommendation: "approve",
      maxScore: 0.01,
    });

    expect(res.status).toBe(404);
    expect([...store.moderations.values()].filter((m) => m.messageId === message.id)).toHaveLength(
      0,
    );
    expect(store.messages.get(message.id)?.status).toBe("received");
  });

  it("serves work inputs (audio SAS + transcript) for a message", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    // Before any transcription: audio SAS is present, transcription is null.
    const first = await app.request(`/v1/worker/messages/${message.id}/work`, {
      headers: phoneHeaders,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      audio: { url: string } | null;
      transcription: unknown;
    };
    expect(firstBody.audio?.url).toContain("http");
    expect(firstBody.transcription).toBeNull();

    // After a non-English transcription + translation: moderationText is the
    // English translation, so the moderation step reads translated text.
    const pending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: pending.id,
      text: "bonjour",
      language: "fr",
    });
    const transcription = [...store.transcriptions.values()].find(
      (t) => t.messageId === message.id,
    );
    await postJson(app, `/v1/worker/messages/${message.id}/translation`, {
      transcriptionId: transcription?.id,
      translatedText: "hello",
      targetLanguage: "en",
    });

    const second = await app.request(`/v1/worker/messages/${message.id}/work`, {
      headers: phoneHeaders,
    });
    const secondBody = (await second.json()) as {
      transcription: {
        text: string;
        moderationText: string;
        moderationInputSha256: string;
      } | null;
    };
    expect(secondBody.transcription?.text).toBe("bonjour");
    expect(secondBody.transcription?.moderationText).toBe("hello");
    expect(secondBody.transcription?.moderationInputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a moderation callback for superseded review text", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const transcriptionPending = await seedPendingTranscription(message.id);
    await postJson(app, `/v1/worker/messages/${message.id}/transcription`, {
      transcriptionId: transcriptionPending.id,
      text: "bonjour",
      language: "fr",
    });
    const transcription = [...store.transcriptions.values()].find(
      (row) => row.messageId === message.id,
    );
    const firstWork = await app.request(`/v1/worker/messages/${message.id}/work`, {
      headers: phoneHeaders,
    });
    const firstBody = (await firstWork.json()) as {
      transcription: { moderationInputSha256: string } | null;
    };

    await postJson(app, `/v1/worker/messages/${message.id}/translation`, {
      transcriptionId: transcription?.id,
      translatedText: "hello",
      targetLanguage: "en",
    });
    const stale = await postJson(app, `/v1/worker/messages/${message.id}/moderation`, {
      transcriptionId: transcription?.id,
      inputSha256: firstBody.transcription?.moderationInputSha256,
      flagged: false,
      recommendation: "approve",
      maxScore: 0.01,
    });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_moderation_input" });
    const pending = [...store.moderations.values()].filter(
      (row) => row.messageId === message.id && row.status === "pending",
    );
    expect(pending).toHaveLength(1);
  });

  it("rejects work-input fetches without a valid API token", async () => {
    const app = createApp();
    const message = seedMessage({ status: "received" });
    const res = await app.request(`/v1/worker/messages/${message.id}/work`, {
      headers: { authorization: "nope" },
    });
    expect(res.status).toBe(401);
  });
});
