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
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedFile, seedMessage } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
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
});
