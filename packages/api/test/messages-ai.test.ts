import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock("../src/lib/azure-blob.js", async () => (await import("./support/fake-azure.js")).fakeAzureModule);
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken: () => async (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }, next: () => Promise<void>) => {
    if (c.req.header("authorization") === "Bearer test-token") {
      await next();
      return;
    }
    return c.json({ error: "invalid_token" }, 401);
  },
}));

import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  // Keep both AI providers disabled so the pipeline writes "disabled"
  // failure rows without touching the network. Routes still exercise the
  // full code path (DB writes, serializers, WS broadcaster).
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  process.env.AUTO_DECISION_MODE = "always_pending";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const seedReceivedMessage = async (app: ReturnType<typeof createApp>): Promise<string> => {
  const sha256 = "c".repeat(64);
  const initiated = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...phoneHeaders },
    body: JSON.stringify({ durationMs: 4000, sha256 }),
  });
  expect(initiated.status, await initiated.clone().text()).toBe(201);
  const slot = await initiated.json();
  fakeBlobs.set(slot.blobName, { exists: true, sizeBytes: 4242, contentType: "audio/flac", sha256 });
  const completed = await app.request(`/v1/messages/${slot.id}/complete`, {
    method: "POST",
    headers: phoneHeaders,
  });
  expect(completed.status).toBe(200);
  return slot.id as string;
};

describe("messages AI routes", () => {
  beforeEach(setup);

  it("returns an empty transcription history for a fresh message", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    // Drain pending microtasks so the auto-kicked pipeline finishes writing
    // its "disabled" failure row.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const cookie = operatorCookie();
    const res = await app.request(`/v1/messages/${id}/transcriptions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    // Auto-kick fired on /complete; we should see one failed row.
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toMatchObject({ status: "failed" });
  });

  it("requires an operator session for transcription history", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    const res = await app.request(`/v1/messages/${id}/transcriptions`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when transcribing an unknown message", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/messages/00000000-0000-0000-0000-000000000000/transcribe", {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("creates a new transcription row when manually triggered", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    await new Promise((resolve) => setImmediate(resolve));
    const cookie = operatorCookie();
    const res = await app.request(`/v1/messages/${id}/transcribe`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ messageId: id, status: "failed", provider: "disabled" });
  });

  it("returns 409 when moderating without a succeeded transcription", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    const cookie = operatorCookie();
    const res = await app.request(`/v1/messages/${id}/moderate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(409);
  });

  it("requires operator auth on /transcribe and /moderate", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    const transcribe = await app.request(`/v1/messages/${id}/transcribe`, { method: "POST" });
    expect(transcribe.status).toBe(401);
    const moderate = await app.request(`/v1/messages/${id}/moderate`, { method: "POST" });
    expect(moderate.status).toBe(401);
  });

  it("includes latestTranscription on the message list and detail responses", async () => {
    const app = createApp();
    const id = await seedReceivedMessage(app);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const cookie = operatorCookie();
    const detail = await app.request(`/v1/messages/${id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.latestTranscription).toMatchObject({ status: "failed", provider: "disabled" });

    const list = await app.request(`/v1/messages?status=received&limit=10`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.items[0]?.latestTranscription).toMatchObject({ status: "failed" });
  });
});
