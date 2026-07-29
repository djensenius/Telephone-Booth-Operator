import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);
// Any bearer credential authenticates as the same fake booth token, so the
// audit rows can assert on API-token attribution without Argon2 hashing.
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken:
    () =>
    async (
      c: {
        req: { header: (name: string) => string | undefined };
        set: (key: string, value: unknown) => void;
        json: (body: unknown, status?: number) => Response;
      },
      next: () => Promise<void>,
    ) => {
      if (c.req.header("authorization")) {
        c.set("apiToken", { id: "11111111-1111-4111-8111-111111111111", name: "booth" });
        c.set("apiTokenId", "11111111-1111-4111-8111-111111111111");
        await next();
        return;
      }
      return c.json({ error: "invalid_token" }, 401);
    },
}));

import { createApp } from "../src/index.js";
import { pruneAuditLogs } from "../src/lib/audit-pruner.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedFile, seedMessage, store } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = (): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  delete process.env.AUDIT_LOG_ENABLED;
  delete process.env.AUDIT_LOG_TELEMETRY;
  delete process.env.TRUSTED_PROXIES;
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const auditFor = (action: string) => store.auditLogs.filter((row) => row.action === action);

describe("audit log middleware", () => {
  beforeEach(setup);

  it("records the operator, IP and timestamp for an approval", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const cookie = operatorCookie();
    process.env.TRUSTED_PROXIES = "10.0.0.1";

    const response = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        "user-agent": "booth-operator-tests/1.0",
      },
      body: JSON.stringify({ decision: "approve", notes: "sounds good" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const entries = auditFor("message.approve");
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.actorType).toBe("operator");
    expect(entry.actorUserId).toBeTruthy();
    expect(entry.actorLabel).toContain("@");
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.userAgent).toBe("booth-operator-tests/1.0");
    expect(entry.targetType).toBe("message");
    expect(entry.targetId).toBe(message.id);
    expect(entry.method).toBe("POST");
    expect(entry.statusCode).toBe(200);
    expect(entry.metadata).toMatchObject({ decision: "approve", previousStatus: "pending" });
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("names rejections separately and records the failed attempt too", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });

    const rejected = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(rejected.status).toBe(200);
    expect(auditFor("message.reject")).toHaveLength(1);

    // No credentials at all: still recorded, as an anonymous 401.
    const denied = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(denied.status).toBe(401);
    const anonymous = store.auditLogs.filter((row) => row.actorType === "anonymous");
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]!.statusCode).toBe(401);
    expect(anonymous[0]!.path).toBe(`/v1/messages/${message.id}/decision`);
  });

  it("ignores reads", async () => {
    const app = createApp();
    const response = await app.request("/v1/messages", { headers: { cookie: operatorCookie() } });
    expect(response.status).toBe(200);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("attributes booth writes to the API token", async () => {
    const app = createApp();
    const sha256 = "a".repeat(64);
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    expect(response.status, await response.clone().text()).toBe(201);

    const entries = auditFor("message.create");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actorType).toBe("apiToken");
    expect(entries[0]!.actorLabel).toBe("token:booth");
    expect(entries[0]!.targetId).toBe((await response.json()).id);
  });

  it("skips booth telemetry heartbeats unless AUDIT_LOG_TELEMETRY is set", async () => {
    const app = createApp();
    const body = JSON.stringify({ state: "idle" });
    const headers = { "content-type": "application/json", ...phoneHeaders };

    const first = await app.request("/v1/status", { method: "PUT", headers, body });
    expect(first.status).toBeLessThan(300);
    expect(store.auditLogs).toHaveLength(0);

    process.env.AUDIT_LOG_TELEMETRY = "true";
    const second = await app.request("/v1/status", { method: "PUT", headers, body });
    expect(second.status).toBeLessThan(300);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]!.action).toBe("http.put /v1/status");
  });

  it("can be disabled entirely", async () => {
    process.env.AUDIT_LOG_ENABLED = "false";
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const response = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(200);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("records transcription work pushed back by the worker", async () => {
    const app = createApp();
    const sha256 = "b".repeat(64);
    const created = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ durationMs: 3000, sha256 }),
    });
    const slot = await created.json();
    fakeBlobs.set(slot.blobName, {
      exists: true,
      sizeBytes: 1234,
      contentType: "audio/flac",
      sha256,
    });
    await app.request(`/v1/messages/${slot.id}/complete`, {
      method: "POST",
      headers: phoneHeaders,
    });

    const pushed = await app.request(`/v1/worker/messages/${slot.id}/transcription`, {
      method: "POST",
      headers: { "content-type": "application/json", ...phoneHeaders },
      body: JSON.stringify({ text: "hello booth", language: "en" }),
    });
    expect(pushed.status, await pushed.clone().text()).toBe(200);

    const entries = auditFor("message.transcription.push");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.targetId).toBe(slot.id);
    // The transcript itself lives on the Transcription row, not the trail.
    expect(entries[0]!.metadata).toMatchObject({ language: "en", textLength: 11 });
    expect(JSON.stringify(entries[0]!.metadata)).not.toContain("hello booth");

    expect(auditFor("message.complete")).toHaveLength(1);
  });
});

describe("GET /v1/audit-logs", () => {
  beforeEach(setup);

  const seedEntries = async (app: ReturnType<typeof createApp>): Promise<void> => {
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie({ isAdmin: true }) },
      body: JSON.stringify({ decision: "approve" }),
    });
  };

  it("requires an admin operator", async () => {
    const app = createApp();
    const anonymous = await app.request("/v1/audit-logs");
    expect(anonymous.status).toBe(401);

    const nonAdmin = await app.request("/v1/audit-logs", {
      headers: { cookie: operatorCookie({ isAdmin: false }) },
    });
    expect(nonAdmin.status).toBe(403);
  });

  it("returns entries newest first and filters by action prefix", async () => {
    const app = createApp();
    await seedEntries(app);

    const response = await app.request("/v1/audit-logs?action=message.", {
      headers: { cookie: operatorCookie({ isAdmin: true }) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].action).toBe("message.approve");
    expect(body.items[0].actorLabel).toContain("@");
    expect(body.nextCursor).toBeNull();

    const filtered = await app.request("/v1/audit-logs?action=question.create", {
      headers: { cookie: operatorCookie({ isAdmin: true }) },
    });
    expect((await filtered.json()).items).toHaveLength(0);
  });

  it("returns the trail for a single target", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie({ isAdmin: true }) },
      body: JSON.stringify({ decision: "reject" }),
    });

    const response = await app.request(`/v1/audit-logs/targets/message/${message.id}`, {
      headers: { cookie: operatorCookie({ isAdmin: true }) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].action).toBe("message.reject");
    expect(body.items[0].targetId).toBe(message.id);
  });
});

describe("audit log pruner", () => {
  beforeEach(setup);

  it("deletes entries older than the retention window", async () => {
    store.auditLogs.push(
      {
        id: "00000000-0000-4000-8000-000000000001",
        action: "message.approve",
        targetType: "message",
        targetId: "old",
        actorType: "operator",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "old@example.com",
        ip: null,
        userAgent: null,
        method: "POST",
        path: "/v1/messages/old/decision",
        statusCode: 200,
        metadata: null,
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        action: "message.approve",
        targetType: "message",
        targetId: "new",
        actorType: "operator",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "new@example.com",
        ip: null,
        userAgent: null,
        method: "POST",
        path: "/v1/messages/new/decision",
        statusCode: 200,
        metadata: null,
        createdAt: new Date(),
      },
    );

    const removed = await pruneAuditLogs({ retentionDays: 365, intervalSeconds: 3600 });
    expect(removed).toBe(1);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]!.targetId).toBe("new");
  });

  it("keeps everything when retention is disabled", async () => {
    store.auditLogs.push({
      id: "00000000-0000-4000-8000-000000000003",
      action: "message.approve",
      targetType: "message",
      targetId: "ancient",
      actorType: "operator",
      actorUserId: null,
      actorTokenId: null,
      actorLabel: "old@example.com",
      ip: null,
      userAgent: null,
      method: "POST",
      path: "/v1/messages/ancient/decision",
      statusCode: 200,
      metadata: null,
      createdAt: new Date(0),
    });

    const removed = await pruneAuditLogs({ retentionDays: 0, intervalSeconds: 3600 });
    expect(removed).toBe(0);
    expect(store.auditLogs).toHaveLength(1);
  });
});
