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
import { resetApnsSenderForTests, setApnsSenderForTests } from "../src/lib/apns.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedFile, seedMessage, seedMobileDevice, seedQuestion } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetApnsSenderForTests();
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

describe("messages routes", () => {
  beforeEach(setup);

  it("runs the message upload flow and lists the received message", async () => {
    const app = createApp();
    const sha256 = "b".repeat(64);

    const unauthorized = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    expect(unauthorized.status).toBe(401);

    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    expect(initiated.status, await initiated.clone().text()).toBe(201);
    const slot = await initiated.json();
    expect(slot).toMatchObject({ blobName: `messages/bb/${sha256}.flac` });
    expect(slot.uploadUrl).toContain("sp=cw");

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
    expect(completed.status, await completed.clone().text()).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ id: slot.id, status: "received" });

    const cookie = operatorCookie();
    const list = await app.request("/v1/messages?status=received&limit=5", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: slot.id,
      status: "received",
      audio: { sha256, durationMs: 3000 },
    });

    const detail = await app.request(`/v1/messages/${slot.id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ id: slot.id, status: "received" });

    const deleted = await app.request(`/v1/messages/${slot.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);
  });

  it("returns 413 when uploaded blob exceeds MAX_AUDIO_BYTES", async () => {
    process.env.MAX_AUDIO_BYTES = "1000";
    const app = createApp();
    const sha256 = "d".repeat(64);

    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    expect(initiated.status).toBe(201);
    const slot = await initiated.json();

    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 5000,
      contentType: "audio/flac",
      sha256,
    });

    const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(completed.status).toBe(413);
    await expect(completed.json()).resolves.toMatchObject({ error: "audio_too_large" });
    delete process.env.MAX_AUDIO_BYTES;
  });

  it("rejects message creation when durationMs exceeds the cap", async () => {
    const app = createApp();
    const sha256 = "e".repeat(64);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 999_999, sha256 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects message creation for a question that is not active", async () => {
    const app = createApp();
    const draft = seedQuestion({ status: "draft" });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256: "a".repeat(64), questionId: draft.id }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "question_not_found" });
  });

  it("accepts message creation for an active question", async () => {
    const app = createApp();
    const active = seedQuestion({ status: "active" });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256: "b".repeat(64), questionId: active.id }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects /complete when blob metadata is missing sha256", async () => {
    const app = createApp();
    const sha256 = "f".repeat(64);

    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    expect(initiated.status).toBe(201);
    const slot = await initiated.json();

    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 4242,
      contentType: "audio/flac",
      sha256: null,
    });

    const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(completed.status).toBe(422);
    await expect(completed.json()).resolves.toMatchObject({ error: "sha256_metadata_missing" });
  });

  it("duplicate /complete is idempotent and does not reset status", async () => {
    const app = createApp();
    const sha256 = "d".repeat(64);

    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, sha256 }),
    });
    expect(initiated.status).toBe(201);
    const slot = await initiated.json();

    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 1234,
      contentType: "audio/flac",
      sha256,
    });

    // First /complete transitions uploading → received
    const first = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ id: slot.id, status: "received" });

    // Second /complete is a no-op retry — should not reset state
    const second = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.id).toBe(slot.id);
    // Status should still be "received" (not rolled back to "uploading")
    expect(body.status).toBe("received");
  });

  it("fans out a messageReceived push with an awaiting-moderation badge on /complete", async () => {
    const app = createApp();
    // One message already awaiting moderation (pending) plus the new one that
    // /complete promotes to "received" → badge should be 2.
    seedMessage({ audioId: seedFile({ sha256: "f".repeat(64) }).id, status: "pending" });
    seedMobileDevice({ userId: "operator-1", platform: "ios" });

    const sent: Array<{ userId: string; badge?: number; preferenceKey: string }> = [];
    setApnsSenderForTests({
      send: async (userId, notification) => {
        sent.push({
          userId,
          badge: notification.badge,
          preferenceKey: notification.preferenceKey,
        });
      },
    });

    const sha256 = "e".repeat(64);
    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, sha256 }),
    });
    expect(initiated.status).toBe(201);
    const slot = await initiated.json();
    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 1234,
      contentType: "audio/flac",
      sha256,
    });

    const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(completed.status, await completed.clone().text()).toBe(200);

    // The push is fire-and-forget; let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      userId: "operator-1",
      preferenceKey: "messageReceived",
      badge: 2,
    });
  });

  it("returns a random approved message with audio sha for the phone client", async () => {
    const app = createApp();
    const audio = seedFile({ sha256: "c".repeat(64), durationMs: 4500 });
    const message = seedMessage({ audioId: audio.id, status: "approved" });

    const random = await app.request("/v1/messages/random", { headers: phoneHeaders });

    expect(random.status, await random.clone().text()).toBe(200);
    await expect(random.json()).resolves.toMatchObject({
      id: message.id,
      status: "approved",
      audio: { sha256: "c".repeat(64), durationMs: 4500 },
    });
  });

  it("returns 404 for random message when no approved messages exist", async () => {
    const app = createApp();
    seedMessage({ status: "received" });

    const random = await app.request("/v1/messages/random", { headers: phoneHeaders });

    expect(random.status).toBe(404);
  });

  it("re-issues a slot (201) for concurrent creates with the same sha256", async () => {
    const app = createApp();
    const sha256 = "d".repeat(64);

    const [first, second] = await Promise.all([
      app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 2000, sha256 }),
      }),
      app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 2000, sha256 }),
      }),
    ]);

    // Idempotent re-initiation: while the message is still "uploading", both
    // callers get a usable slot for the same message id rather than a 409.
    expect([first.status, second.status]).toEqual([201, 201]);
    const [a, b] = await Promise.all([first.json(), second.json()]);
    expect(a.id).toBe(b.id);
    expect(a.uploadUrl).toContain("sp=cw");
    expect(b.uploadUrl).toContain("sp=cw");
  });

  it("re-issues a fresh slot when re-creating an uploading message (reboot recovery)", async () => {
    const app = createApp();
    const sha256 = "e".repeat(64);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      const first = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 2000, sha256 }),
      });
      expect(first.status).toBe(201);
      const firstSlot = await first.json();

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));

      // Blob was never uploaded; the booth reboots and re-POSTs the same sha256.
      const second = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 2000, sha256 }),
      });
      expect(second.status).toBe(201);
      const secondSlot = await second.json();
      expect(secondSlot.id).toBe(firstSlot.id);
      expect(secondSlot.blobName).toBe(firstSlot.blobName);
      expect(secondSlot.uploadUrl).toContain("sp=cw");
      expect(Date.parse(new URL(secondSlot.uploadUrl).searchParams.get("se") ?? "")).toBeGreaterThan(
        Date.parse(new URL(firstSlot.uploadUrl).searchParams.get("se") ?? ""),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-issues a slot for an uploading message after its question leaves active", async () => {
    const app = createApp();
    const question = seedQuestion();
    const sha256 = "1".repeat(64);

    const first = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, questionId: question.id, sha256 }),
    });
    expect(first.status).toBe(201);
    const firstSlot = await first.json();

    question.status = "draft";

    const second = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, questionId: question.id, sha256 }),
    });
    expect(second.status).toBe(201);
    const secondSlot = await second.json();
    expect(secondSlot.id).toBe(firstSlot.id);
    expect(secondSlot.blobName).toBe(firstSlot.blobName);
  });

  it("returns 409 when the same upload is retried for a different question", async () => {
    const app = createApp();
    const firstQuestion = seedQuestion();
    const secondQuestion = seedQuestion();
    const sha256 = "2".repeat(64);

    const first = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, questionId: firstQuestion.id, sha256 }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, questionId: secondQuestion.id, sha256 }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "message_already_exists" });
  });

  it("does not issue message upload SAS URLs for question audio files", async () => {
    const app = createApp();
    const sha256 = "3".repeat(64);
    const audio = seedFile({ sha256 });
    seedQuestion({ audioId: audio.id });

    const created = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, sha256 }),
    });
    expect(created.status).toBe(409);
    await expect(created.json()).resolves.toMatchObject({ error: "message_already_exists" });
  });

  it("returns 409 when re-creating a message that already left uploading", async () => {
    const app = createApp();
    const sha256 = "f".repeat(64);

    const first = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, sha256 }),
    });
    expect(first.status).toBe(201);
    const slot = await first.json();

    // Complete the upload so the message advances past "uploading".
    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 1234,
      contentType: "audio/flac",
      sha256,
    });
    const complete = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(complete.status).toBe(200);

    // A genuine duplicate: the recording already landed.
    const second = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 2000, sha256 }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "message_already_exists" });
  });
});
