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
import { fakeDb, resetFakeDb } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  // Keep AI disabled so /complete's auto-kick writes a "disabled" failure row
  // without touching the network; review routes still exercise the full path.
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  process.env.AUTO_DECISION_MODE = "always_pending";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const seedReceivedMessage = async (app: ReturnType<typeof createApp>): Promise<string> => {
  const sha256 = "d".repeat(64);
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
        expect.objectContaining({ kind: "message", message: expect.objectContaining({ id, status: "approved" }) }),
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
      const res = await app.request(
        "/v1/messages/00000000-0000-0000-0000-000000000000/decision",
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        },
      );
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
      await fakeDb.transcription.create({
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
        body: JSON.stringify({ translatedText: "  hello world  ", translatedLanguage: "en" }),
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
});
