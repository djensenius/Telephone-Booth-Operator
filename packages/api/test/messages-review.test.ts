import { createHash } from "node:crypto";
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
import { wsBroadcaster } from "../src/lib/broadcaster.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { fakeDb, resetFakeDb, store } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  // Keep AI disabled so /complete's auto-kick writes a "disabled" failure row
  // without touching the network; review routes still exercise the full path.
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const seedReceivedMessage = async (
  app: ReturnType<typeof createApp>,
  sha256 = "d".repeat(64),
): Promise<string> => {
  const initiated = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...phoneHeaders },
    body: JSON.stringify({ durationMs: 4000, sha256 }),
  });
  expect(initiated.status, await initiated.clone().text()).toBe(201);
  const slot = await initiated.json();
  fakeBlobs.set(slot.blobName, {
    exists: true,
    sizeBytes: 4242,
    contentType: "audio/flac",
    sha256,
  });
  const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
    method: "POST",
    headers: phoneHeaders,
  });
  expect(completed.status).toBe(200);
  // Drain the auto-kicked pipeline so it finishes writing its failure row.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return slot.id as string;
};

describe("message review actions", () => {
  beforeEach(setup);

  describe("POST /:id/decision", () => {
    it("approves a message and records the deciding operator", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const broadcasts: Array<{ kind: string }> = [];
      wsBroadcaster.subscribe("test-decision", (e) => broadcasts.push(e));
      const res = await app.request(`/v1/messages/${id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      wsBroadcaster.unsubscribe("test-decision");
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id, status: "approved", decidedById: "operator-1" });
      expect(typeof body.decidedAt).toBe("string");
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          kind: "message",
          message: expect.objectContaining({ id, status: "approved" }),
        }),
      );
    });

    it("rejects a message and stores the supplied notes", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject", notes: "off-topic" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id, status: "rejected", notes: "off-topic" });
    });

    it("returns 409 for a message still uploading", async () => {
      const app = createApp();
      const sha256 = "e".repeat(64);
      const initiated = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 4000, sha256 }),
      });
      const slot = await initiated.json();
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${slot.id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "message_not_decidable" });
    });

    it("returns 404 for an unknown message", async () => {
      const app = createApp();
      const cookie = operatorCookie();
      const res = await app.request("/v1/messages/00000000-0000-0000-0000-000000000000/decision", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects an invalid decision value", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/decision`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      });
      expect(res.status).toBe(400);
    });

    it("requires an operator session", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const res = await app.request(`/v1/messages/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/translation", () => {
    it("attaches a human translation to the latest succeeded transcription", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "openai",
          model: "whisper-1",
          status: "succeeded",
          text: "hola mundo",
          language: "es",
          durationMs: 4000,
          completedAt: new Date(),
        },
      });

      const cookie = operatorCookie();
      const broadcasts: Array<{ kind: string }> = [];
      wsBroadcaster.subscribe("test-translation", (e) => broadcasts.push(e));
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          expectedTranscriptionId: transcription.id,
          expectedTranslationSha256: null,
          translatedText: "  hello world  ",
          translatedLanguage: "en",
        }),
      });
      wsBroadcaster.unsubscribe("test-translation");
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        messageId: id,
        translationStatus: "succeeded",
        translatedText: "hello world",
        translatedLanguage: "en",
        translationProvider: null,
      });
      expect(typeof body.translationCompletedAt).toBe("string");
      expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "message" }));
    });

    it("rejects a human correction when its expected transcription was superseded", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const stale = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "hola",
          createdAt: new Date(1),
        },
      });
      await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "bonjour",
          createdAt: new Date(2),
        },
      });

      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedTranscriptionId: stale.id,
          translatedText: "hello",
        }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_transcription" });
    });

    it("rejects a translation when the observed translation content changed", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "hola",
          translationStatus: "succeeded",
          translatedText: "newer translation",
          createdAt: new Date(),
        },
      });

      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedTranscriptionId: transcription.id,
          expectedTranslationSha256: createHash("sha256")
            .update("older translation", "utf8")
            .digest("hex"),
          translatedText: "my correction",
        }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_translation" });
      expect(store.transcriptions.get(transcription.id)?.translatedText).toBe("newer translation");
    });

    it("targets and attributes an on-device translation", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "hola mundo",
          language: "es",
          completedAt: new Date(),
        },
      });
      const moderation = await fakeDb.moderation.create({
        data: {
          messageId: id,
          transcriptionId: transcription.id,
          provider: "on_device",
          status: "succeeded",
          recommendation: "approve",
          completedAt: new Date(),
        },
      });
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          transcriptionId: transcription.id,
          expectedTranslationSha256: null,
          translatedText: "hello world",
          translatedLanguage: "en",
          model: "apple-foundation-models",
        }),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({
        id: transcription.id,
        translationProvider: "on_device",
        translationModel: "apple-foundation-models",
      });
      expect(store.moderations.get(moderation.id)).toMatchObject({
        status: "failed",
        error: "superseded_by_translation",
      });
    });

    it("keeps moderation when an identical translation is retried", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "hola mundo",
          translatedText: "hello world",
          translatedLanguage: "en",
          translationStatus: "succeeded",
          completedAt: new Date(),
        },
      });
      const moderation = await fakeDb.moderation.create({
        data: {
          messageId: id,
          transcriptionId: transcription.id,
          provider: "on_device",
          status: "succeeded",
          recommendation: "approve",
          completedAt: new Date(),
        },
      });

      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          transcriptionId: transcription.id,
          expectedTranslationSha256: createHash("sha256").update("hello world", "utf8").digest("hex"),
          translatedText: "hello world",
          translatedLanguage: "en",
          model: "apple-foundation-models",
        }),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      expect(store.moderations.get(moderation.id)).toMatchObject({
        status: "succeeded",
        error: null,
      });
    });

    it("does not invalidate moderation for older transcription history", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const older = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "bonjour",
          createdAt: new Date(1),
        },
      });
      const latest = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "hola",
          createdAt: new Date(2),
        },
      });
      const olderModeration = await fakeDb.moderation.create({
        data: {
          messageId: id,
          transcriptionId: older.id,
          provider: "push",
          status: "succeeded",
          recommendation: "review",
          completedAt: new Date(),
        },
      });

      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          transcriptionId: latest.id,
          translatedText: "hello",
          translatedLanguage: "en",
        }),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      expect(store.moderations.get(olderModeration.id)?.status).toBe("succeeded");
    });

    it("rejects a superseded targeted translation", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const stale = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "hola",
          createdAt: new Date(1),
        },
      });
      await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "bonjour",
          createdAt: new Date(2),
        },
      });
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ transcriptionId: stale.id, translatedText: "hello" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_transcription" });
    });

    it("returns 409 when there is no succeeded transcription", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ translatedText: "hello" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "no_succeeded_transcription" });
    });

    it("rejects an empty translation", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ translatedText: "   " }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown message", async () => {
      const app = createApp();
      const cookie = operatorCookie();
      const res = await app.request(
        "/v1/messages/00000000-0000-0000-0000-000000000000/translation",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ translatedText: "hello" }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("requires an operator session", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const res = await app.request(`/v1/messages/${id}/translation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ translatedText: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/transcription", () => {
    it("finalizes a pending transcription and attributes it to the operator", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const pending = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          model: null,
          status: "pending",
          requestedById: null,
        },
      });
      const cookie = operatorCookie();
      const broadcasts: Array<{ kind: string }> = [];
      wsBroadcaster.subscribe("test-transcription", (e) => broadcasts.push(e));
      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hola mundo", language: "es", model: "apple-speech" }),
      });
      wsBroadcaster.unsubscribe("test-transcription");
      expect(res.status, await res.clone().text()).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({
        id: pending.id,
        messageId: id,
        status: "succeeded",
        text: "hola mundo",
        language: "es",
        model: "apple-speech",
        requestedById: "operator-1",
      });
      expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "message" }));
    });

    it("records a new succeeded transcription when none is pending", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello there" }),
      });
      expect(res.status, await res.clone().text()).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({
        messageId: id,
        provider: "on_device",
        status: "succeeded",
        text: "hello there",
        requestedById: "operator-1",
      });
    });

    it("can suppress server-side translation and moderation", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          text: "hola mundo",
          language: "es",
          model: "apple-speech",
          processDownstream: false,
        }),
      });

      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({
        provider: "on_device",
        translationStatus: null,
      });
      expect([...store.moderations.values()].filter((row) => row.messageId === id)).toHaveLength(0);
    });

    it("rejects a transcript when the latest snapshot changed", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const baseline = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "first",
          createdAt: new Date(1),
        },
      });
      await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "newer",
          createdAt: new Date(2),
        },
      });

      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedLatestTranscriptionId: baseline.id,
          text: "local result",
          processDownstream: false,
        }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_transcription" });
    });

    it("conditionally records a first transcript when the expected snapshot is null", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);

      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie: operatorCookie(), "content-type": "application/json" },
        body: JSON.stringify({
          expectedLatestTranscriptionId: null,
          text: "first local result",
          processDownstream: false,
        }),
      });

      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({ text: "first local result" });
    });

    it("accepts an empty transcript for a silent recording", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      expect(res.status, await res.clone().text()).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({ messageId: id, status: "succeeded", text: "" });
    });

    it("treats an identical resubmission as a no-op", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const headers = { cookie, "content-type": "application/json" };
      const body = JSON.stringify({ text: "hello there", language: "en" });

      const first = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers,
        body,
      });
      const second = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers,
        body,
      });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(await first.json()).toMatchObject({ id: (await second.json()).id });
      const rows = [...store.transcriptions.values()].filter((t) => t.messageId === id);
      expect(rows).toHaveLength(1);
    });

    it("records a corrected language for the same text as a new attempt", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const headers = { cookie, "content-type": "application/json" };

      await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "bonjour" }),
      });
      const corrected = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "bonjour", language: "fr" }),
      });

      expect(corrected.status, await corrected.clone().text()).toBe(202);
      expect(await corrected.json()).toMatchObject({ language: "fr" });
      const rows = [...store.transcriptions.values()].filter((t) => t.messageId === id);
      expect(rows).toHaveLength(2);
    });

    it("returns 404 for an unknown message", async () => {
      const app = createApp();
      const cookie = operatorCookie();
      const res = await app.request(
        "/v1/messages/00000000-0000-0000-0000-000000000000/transcription",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: "hello" }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("requires an operator session", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const res = await app.request(`/v1/messages/${id}/transcription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/moderation", () => {
    const verdict = {
      flagged: true,
      recommendation: "reject",
      maxScore: 0.82,
      categories: { hate: 0.82 },
      reasonSummary: "slur",
      model: "apple-foundation-models",
    };

    it("finalizes a pending moderation and attributes it to the operator", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          status: "succeeded",
          text: "hello there",
          completedAt: new Date(),
        },
      });
      const pending = await fakeDb.moderation.create({
        data: {
          messageId: id,
          transcriptionId: transcription.id,
          provider: "push",
          model: null,
          status: "pending",
          requestedById: null,
        },
      });
      const cookie = operatorCookie();
      const broadcasts: Array<{ kind: string }> = [];
      wsBroadcaster.subscribe("test-moderation", (e) => broadcasts.push(e));
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ...verdict,
          transcriptionId: transcription.id,
          inputSha256: createHash("sha256").update("hello there", "utf8").digest("hex"),
        }),
      });
      wsBroadcaster.unsubscribe("test-moderation");
      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({
        id: pending.id,
        messageId: id,
        transcriptionId: transcription.id,
        provider: "on_device",
        status: "succeeded",
        flagged: true,
        recommendation: "reject",
        maxScore: 0.82,
        model: "apple-foundation-models",
        requestedById: "operator-1",
      });
      expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "message" }));
    });

    it("records a new succeeded moderation when none is pending", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(verdict),
      });
      expect(res.status, await res.clone().text()).toBe(202);
      expect(await res.json()).toMatchObject({
        messageId: id,
        transcriptionId: null,
        provider: "on_device",
        status: "succeeded",
        recommendation: "reject",
        requestedById: "operator-1",
      });
    });

    it("rejects a verdict for stale input text", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "bonjour",
          translatedText: "hello",
          translationStatus: "succeeded",
        },
      });
      const cookie = operatorCookie();
      const inputSha256 = createHash("sha256").update("different", "utf8").digest("hex");
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...verdict, transcriptionId: transcription.id, inputSha256 }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "stale_moderation_input" });
      expect([...store.moderations.values()].filter((row) => row.messageId === id)).toHaveLength(0);
    });

    it("requires an input hash for targeted moderation", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const transcription = await fakeDb.transcription.create({
        data: { messageId: id, provider: "on_device", status: "succeeded", text: "hello" },
      });
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...verdict, transcriptionId: transcription.id }),
      });

      expect(res.status).toBe(400);
    });

    it("never decides the message", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(verdict),
      });
      expect(res.status).toBe(202);
      expect(store.messages.get(id)?.status).toBe("pending");
    });

    it("treats an identical resubmission as a no-op", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const headers = { cookie, "content-type": "application/json" };
      const body = JSON.stringify(verdict);

      const first = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body,
      });
      const second = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body,
      });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(await first.json()).toMatchObject({ id: (await second.json()).id });
      const rows = [...store.moderations.values()].filter((m) => m.messageId === id);
      expect(rows).toHaveLength(1);
    });

    it("does not inherit the solicited row's model when none is submitted", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      await fakeDb.moderation.create({
        data: {
          messageId: id,
          provider: "push",
          model: "omni-moderation-latest",
          status: "pending",
        },
      });
      const cookie = operatorCookie();
      const { model: _model, ...withoutModel } = verdict;
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(withoutModel),
      });
      expect(res.status, await res.clone().text()).toBe(202);
      // Restamping the provider claims the whole attribution: crediting the
      // upstream model for an on-device verdict would be a lie.
      expect(await res.json()).toMatchObject({ provider: "on_device", model: null });
    });

    it("records a corrected category score as a new attempt", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const headers = { cookie, "content-type": "application/json" };

      await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body: JSON.stringify(verdict),
      });
      const corrected = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...verdict, categories: { hate: 0.91 } }),
      });

      expect(corrected.status, await corrected.clone().text()).toBe(202);
      expect(await corrected.json()).toMatchObject({ categories: { hate: 0.91 } });
      const rows = [...store.moderations.values()].filter((m) => m.messageId === id);
      expect(rows).toHaveLength(2);
    });

    it("appends its verdict when another writer finalizes the pending row first", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const pending = await fakeDb.moderation.create({
        data: { messageId: id, provider: "push", model: null, status: "pending" },
      });
      // Simulate losing the compare-and-set: the row is finalized by someone
      // else between the read and the guarded update.
      const updateMany = vi.spyOn(fakeDb.moderation, "updateMany").mockResolvedValueOnce({
        count: 0,
      } as never);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(verdict),
      });
      updateMany.mockRestore();

      expect(res.status, await res.clone().text()).toBe(202);
      const body = await res.json();
      expect(body.id).not.toBe(pending.id);
      expect(body).toMatchObject({ provider: "on_device", recommendation: "reject" });
    });

    it("records a changed verdict as a new attempt", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const headers = { cookie, "content-type": "application/json" };

      await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body: JSON.stringify(verdict),
      });
      const revised = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...verdict, flagged: false, recommendation: "approve" }),
      });

      expect(revised.status, await revised.clone().text()).toBe(202);
      expect(await revised.json()).toMatchObject({ flagged: false, recommendation: "approve" });
      const rows = [...store.moderations.values()].filter((m) => m.messageId === id);
      expect(rows).toHaveLength(2);
    });

    it("rejects a transcription belonging to another message", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const otherId = await seedReceivedMessage(app, "e".repeat(64));
      const foreign = await fakeDb.transcription.create({
        data: { messageId: otherId, provider: "push", status: "succeeded", text: "elsewhere" },
      });
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ...verdict,
          transcriptionId: foreign.id,
          inputSha256: createHash("sha256").update("foreign", "utf8").digest("hex"),
        }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "transcription_not_found" });
    });

    it("rejects an out-of-range score", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const cookie = operatorCookie();
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...verdict, maxScore: 1.5 }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for an unknown message", async () => {
      const app = createApp();
      const cookie = operatorCookie();
      const res = await app.request(
        "/v1/messages/00000000-0000-0000-0000-000000000000/moderation",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(verdict),
        },
      );
      expect(res.status).toBe(404);
    });

    it("requires an operator session", async () => {
      const app = createApp();
      const id = await seedReceivedMessage(app);
      const res = await app.request(`/v1/messages/${id}/moderation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verdict),
      });
      expect(res.status).toBe(401);
    });
  });
});
