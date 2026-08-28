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
import type { ApnsNotification } from "../src/lib/apns.js";
import { resetApnsSenderForTests, setApnsSenderForTests } from "../src/lib/apns.js";
import { wsBroadcaster, type WsEnvelope } from "../src/lib/broadcaster.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import {
  fakeDb,
  resetFakeDb,
  seedFile,
  seedMessage,
  seedMobileDevice,
  seedQuestion,
  store,
} from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  resetSessionCryptoForTests();
  resetApnsSenderForTests();
  delete process.env.MODERATION_QUEUE_HIGH_THRESHOLD;
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

// Capture every envelope the router broadcasts during a test.
const captureEnvelopes = (): { events: WsEnvelope[]; stop: () => void } => {
  const events: WsEnvelope[] = [];
  const clientId = `test-${Math.random()}`;
  wsBroadcaster.subscribe(clientId, (e) => events.push(e));
  return { events, stop: () => wsBroadcaster.unsubscribe(clientId) };
};

describe("messages routes", () => {
  beforeEach(setup);

  it("queues a completed message for review without waiting on a transcription", async () => {
    // Transcription is push-only and optional: the external app posts one when
    // it has it. A landed recording must never wait on that to be reviewable,
    // and the API must not solicit the work.
    process.env.TRANSCRIPTION_PROVIDER = "push";
    const app = createApp();
    const sha256 = "e".repeat(64);
    const initiated = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    const slot = await initiated.json();
    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 4242,
      contentType: "audio/flac",
      sha256,
    });

    const cap = captureEnvelopes();
    const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    cap.stop();

    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: "pending" });
    expect(store.messages.get(slot.id)?.status).toBe("pending");
    expect([...store.transcriptions.values()]).toHaveLength(0);
    expect(cap.events.some((e) => e.kind === "work")).toBe(false);
  });

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
    await expect(completed.json()).resolves.toMatchObject({ id: slot.id, status: "pending" });

    const cookie = operatorCookie();
    const list = await app.request("/v1/messages?status=pending&limit=5", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: slot.id,
      status: "pending",
      audio: { sha256, durationMs: 3000 },
    });

    const detail = await app.request(`/v1/messages/${slot.id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ id: slot.id, status: "pending" });

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

    // First /complete transitions uploading → pending
    const first = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ id: slot.id, status: "pending" });

    // Second /complete is a no-op retry — should not reset state
    const second = await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.id).toBe(slot.id);
    // Status should still be "pending" (not rolled back to "uploading")
    expect(body.status).toBe("pending");
  });

  it("fans out a messageReceived push with an awaiting-moderation badge on /complete", async () => {
    const app = createApp();
    // One message already awaiting moderation (pending) plus the new one that
    // /complete promotes to "pending" → badge should be 2.
    seedMessage({ audioId: seedFile({ sha256: "f".repeat(64) }).id, status: "pending" });
    seedMobileDevice({ userId: "operator-1", platform: "ios" });

    const sent: Array<{
      userId: string;
      kind: ApnsNotification["kind"];
      badge?: number;
      preferenceKey?: string;
      title?: string;
      body?: string;
      collapseId?: string;
      data?: Record<string, unknown>;
    }> = [];
    setApnsSenderForTests({
      send: async (userId, notification) => {
        sent.push({
          userId,
          kind: notification.kind,
          ...(notification.kind === "alert"
            ? {
                preferenceKey: notification.preferenceKey,
                title: notification.title,
                body: notification.body,
                badge: notification.badge,
                collapseId: notification.collapseId,
                data: notification.data,
              }
            : { badge: notification.badge }),
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

    expect(sent).toEqual(
      expect.arrayContaining([
        {
          userId: "operator-1",
          kind: "alert",
          preferenceKey: "messageReceived",
          title: "Messages waiting",
          body: "Open the moderation queue to review new booth recordings.",
          badge: undefined,
          collapseId: "message-moderation-queue",
          data: {
            notificationKind: "messageQueue",
          },
        },
        {
          userId: "operator-1",
          kind: "badge",
          badge: 2,
        },
      ]),
    );
  });

  it("pushes badge decrements after decisions and deletions", async () => {
    const app = createApp();
    const first = seedMessage({ status: "pending" });
    const second = seedMessage({ status: "pending" });
    seedMobileDevice({
      userId: "operator-1",
      preferences: { messageReceived: false },
    });
    const badges: number[] = [];
    setApnsSenderForTests({
      send: async (_userId, notification) => {
        if (notification.kind === "badge") badges.push(notification.badge);
      },
    });

    const decided = await app.request(`/v1/messages/${first.id}/decision`, {
      method: "POST",
      headers: { cookie: operatorCookie(), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decided.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badges.at(-1)).toBe(1);

    const deleted = await app.request(`/v1/messages/${second.id}`, {
      method: "DELETE",
      headers: { cookie: operatorCookie() },
    });
    expect(deleted.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badges.at(-1)).toBe(0);
  });

  it("re-arms after the queue drops below the high threshold", async () => {
    process.env.MODERATION_QUEUE_HIGH_THRESHOLD = "2";
    const app = createApp();
    seedMessage({ audioId: seedFile({ sha256: "1".repeat(64) }).id, status: "pending" });
    seedMobileDevice({
      userId: "operator-1",
      platform: "ios",
      preferences: { moderationQueueHigh: true },
    });
    const sent: ApnsNotification[] = [];
    setApnsSenderForTests({
      send: async (_userId, notification) => {
        sent.push(notification);
      },
    });

    const complete = async (sha256: string): Promise<string> => {
      const initiated = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 2000, sha256 }),
      });
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
      expect(completed.status).toBe(200);
      return slot.id as string;
    };

    const first = await complete("2".repeat(64));
    const second = await complete("3".repeat(64));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cookie = operatorCookie();
    const deleted = await app.request(`/v1/messages/${first}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);
    const decided = await app.request(`/v1/messages/${second}/decision`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decided.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await complete("4".repeat(64));
    await complete("5".repeat(64));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      sent
        .filter((entry) => entry.kind === "alert" && entry.preferenceKey === "moderationQueueHigh")
        .map((entry) => entry.data?.awaitingModeration),
    ).toEqual([2, 2]);
  });

  it("keeps a successful deletion successful when queue refresh fails", async () => {
    const app = createApp();
    const message = seedMessage({ status: "pending" });
    vi.spyOn(fakeDb.message, "count").mockRejectedValueOnce(new Error("count unavailable"));

    const deleted = await app.request(`/v1/messages/${message.id}`, {
      method: "DELETE",
      headers: { cookie: operatorCookie() },
    });
    expect(deleted.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.messages.has(message.id)).toBe(false);
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
      expect(
        Date.parse(new URL(secondSlot.uploadUrl).searchParams.get("se") ?? ""),
      ).toBeGreaterThan(Date.parse(new URL(firstSlot.uploadUrl).searchParams.get("se") ?? ""));
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
