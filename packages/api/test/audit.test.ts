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
import { resetAuditThrottleForTests, sanitizeMetadata } from "../src/lib/audit.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure } from "./support/fake-azure.js";
import { fakeDb, resetFakeDb, seedFile, seedMessage, store } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = (): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.TRANSCRIPTION_PROVIDER = "disabled";
  process.env.MODERATION_PROVIDER = "disabled";
  delete process.env.AUDIT_LOG_ENABLED;
  delete process.env.AUDIT_LOG_TELEMETRY;
  delete process.env.TRUSTED_PROXIES;
  delete process.env.AUDIT_LOG_ANON_LIMIT_PER_MINUTE;
  resetAuditThrottleForTests();
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const auditFor = (action: string) => store.auditLogs.filter((row) => row.action === action);

// `app.request(url, init, env)` passes `env` straight through to the Node
// conninfo helper, which is how the API learns the TCP peer address.
const fromPeer = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress, remotePort: 51234, remoteFamily: "IPv4" } },
});

describe("audit metadata bounds", () => {
  it("caps depth, width and total size so a row cannot grow unbounded", () => {
    expect(sanitizeMetadata({ deep: { a: { b: { c: "buried" } } } })).toEqual({
      deep: { a: { b: "[truncated]" } },
    });

    const wide = sanitizeMetadata({ items: Array.from({ length: 25 }, (_, i) => i) });
    expect((wide?.items as unknown[]).length).toBe(21);
    expect((wide?.items as unknown[])[20]).toBe("[truncated]");

    const huge = sanitizeMetadata({ blob: { text: "x".repeat(2000) }, more: "y".repeat(2000) });
    expect(huge).toEqual({ blob: { text: "x".repeat(2000) }, more: "y".repeat(2000) });

    const overflowing = sanitizeMetadata(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "z".repeat(1500)])),
    );
    expect(overflowing?.error).toBe("metadata_too_large");
  });

  it("truncates the key names it reports when a row is too large", () => {
    const marker = sanitizeMetadata({ ["k".repeat(50_000)]: "value", other: "z".repeat(9000) });
    expect(marker?.error).toBe("metadata_too_large");
    const keys = marker?.keys as string[];
    expect(keys[0]?.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(marker).length).toBeLessThan(5000);
  });

  it("breaks a cycle instead of failing the row", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // The depth cap cuts the loop, so this stays serializable.
    expect(sanitizeMetadata({ cyclic })).toEqual({ cyclic: { self: { self: "[truncated]" } } });
  });

  it("strips a value that would take over serialization", () => {
    const hostile = {
      toJSON: () => {
        throw new Error("nope");
      },
    };
    // The copy carries data only, so a hostile `toJSON` never runs.
    expect(sanitizeMetadata({ hostile })).toEqual({ hostile: { toJSON: "[unsupported]" } });
  });
});

describe("audit log middleware", () => {
  beforeEach(setup);

  it("records the operator, IP and timestamp for an approval", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const cookie = operatorCookie();
    process.env.TRUSTED_PROXIES = "10.0.0.1";

    const response = await app.request(
      `/v1/messages/${message.id}/decision`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-forwarded-for": "203.0.113.7, 10.0.0.1",
          "user-agent": "booth-operator-tests/1.0",
        },
        body: JSON.stringify({ decision: "approve", notes: "sounds good" }),
      },
      fromPeer("10.0.0.1"),
    );
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

  it("ignores a forwarded address from an untrusted peer", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    // The proxy we trust is 10.0.0.1; this request came straight from the
    // internet and merely claims to have been forwarded.
    process.env.TRUSTED_PROXIES = "10.0.0.1";

    await app.request(
      `/v1/messages/${message.id}/decision`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: operatorCookie(),
          "x-forwarded-for": "198.51.100.9",
        },
        body: JSON.stringify({ decision: "approve" }),
      },
      fromPeer("203.0.113.200"),
    );

    const entry = auditFor("message.approve")[0]!;
    expect(entry.ip).toBe("203.0.113.200");
  });

  it("accepts a forwarded address from a proxy inside a trusted CIDR", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    process.env.TRUSTED_PROXIES = "10.0.0.0/8";

    await app.request(
      `/v1/messages/${message.id}/decision`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: operatorCookie(),
          "x-forwarded-for": "198.51.100.9, 10.4.2.1",
        },
        body: JSON.stringify({ decision: "approve" }),
      },
      fromPeer("::ffff:10.4.2.1"),
    );

    const entry = auditFor("message.approve")[0]!;
    expect(entry.ip).toBe("198.51.100.9");
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

  it("ignores writes to paths that match no route", async () => {
    const app = createApp();
    const response = await app.request("/v1/not-a-real-endpoint", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: "{}",
    });
    expect(response.status).toBe(404);
    // Otherwise any caller could mint rows at will, on paths of their choosing.
    expect(store.auditLogs).toHaveLength(0);
  });

  it("ignores an unauthenticated write to a path that matches no route", async () => {
    const app = createApp();
    // The auth guard answers first, so the check cannot rely on the 404.
    const response = await app.request("/v1/nothing/here", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("still answers the request when the audit insert fails", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const create = fakeDb.auditLog.create;
    fakeDb.auditLog.create = async () => {
      throw new Error("audit sink is down");
    };
    try {
      const response = await app.request(`/v1/messages/${message.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: operatorCookie() },
        body: JSON.stringify({ decision: "approve" }),
      });
      // A broken trail must never take a write endpoint down with it.
      expect(response.status).toBe(200);
    } finally {
      fakeDb.auditLog.create = create;
    }
    expect(store.auditLogs).toHaveLength(0);
  });

  it("caps anonymous sign-in failures the same way as anonymous writes", async () => {
    process.env.AUDIT_LOG_ANON_LIMIT_PER_MINUTE = "2";
    const app = createApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request("/v1/auth/callback?error=access_denied");
      expect(response.status).toBe(400);
    }
    // The callback is a GET, so the middleware quota never sees it.
    expect(auditFor("auth.login.failed")).toHaveLength(2);
  });

  it("does not record a sign-out that had no session to end", async () => {
    const app = createApp();
    const response = await app.request("/v1/auth/logout", { method: "POST" });
    expect(response.status).toBe(302);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("still records a write to a real endpoint that authentication rejected", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const response = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(401);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]!.statusCode).toBe(401);
    expect(store.auditLogs[0]!.actorType).toBe("anonymous");
  });

  it("names the endpoint a denied write was aimed at", async () => {
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const response = await app.request(`/v1/messages/${message.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(response.status).toBe(401);
    // Not `http.post /v1/*`: an action filter has to be able to tell these
    // attempts apart.
    expect(store.auditLogs[0]!.action).toBe("http.post /v1/messages/:id/decision");
  });

  it("caps anonymous rejected writes per address and counts the overflow", async () => {
    process.env.AUDIT_LOG_ANON_LIMIT_PER_MINUTE = "3";
    const app = createApp();
    const file = seedFile();
    const message = seedMessage({ audioId: file.id, status: "pending" });
    const send = async (): Promise<Response> =>
      app.request(`/v1/messages/${message.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await send()).status).toBe(401);
    }
    expect(store.auditLogs).toHaveLength(3);

    // The evidence of the flood survives the next window even though the
    // rows themselves do not.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect((await send()).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
    expect(store.auditLogs).toHaveLength(4);
    expect(store.auditLogs[3]!.metadata).toMatchObject({ suppressedSince: 3 });
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

  it("still records a telemetry heartbeat the API refused", async () => {
    const app = createApp();
    const denied = await app.request("/v1/status", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "idle" }),
    });

    expect(denied.status).toBe(401);
    expect(store.auditLogs).toHaveLength(1);
    expect(store.auditLogs[0]!.action).toBe("http.put /v1/status");
    expect(store.auditLogs[0]!.actorType).toBe("anonymous");
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

  // Seed rows directly so several share a timestamp: that collision is exactly
  // what the (createdAt, id) tuple in the cursor exists to survive.
  const seedAtSameInstant = (count: number, targetId: string): void => {
    const createdAt = new Date("2026-07-20T12:00:00.000Z");
    for (let index = 0; index < count; index += 1) {
      store.auditLogs.push({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        action: "message.approve",
        targetType: "message",
        targetId,
        actorType: "operator",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "operator@example.com",
        ip: null,
        userAgent: null,
        method: "POST",
        path: `/v1/messages/${targetId}/decision`,
        statusCode: 200,
        metadata: null,
        createdAt,
      });
    }
  };

  const drain = async (app: ReturnType<typeof createApp>, path: string): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url: string = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
      const response = await app.request(url, {
        headers: { cookie: operatorCookie({ isAdmin: true }) },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      seen.push(...body.items.map((item: { id: string }) => item.id));
      cursor = body.nextCursor;
      if (!cursor) return seen;
    }
    throw new Error("cursor never terminated");
  };

  it("matches the action filter as a prefix so families stay together", async () => {
    const app = createApp();
    const targetId = "44444444-4444-4444-8444-444444444444";
    seedAtSameInstant(1, targetId);
    store.auditLogs.push(
      {
        id: "10000000-0000-4000-8000-000000000001",
        action: "auth.login",
        targetType: null,
        targetId: null,
        actorType: "operator",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "operator@example.com",
        ip: null,
        userAgent: null,
        method: "GET",
        path: "/v1/auth/callback",
        statusCode: 302,
        metadata: null,
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        action: "auth.login.denied",
        targetType: null,
        targetId: null,
        actorType: "anonymous",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "anonymous",
        ip: null,
        userAgent: null,
        method: "GET",
        path: "/v1/auth/callback",
        statusCode: 403,
        metadata: null,
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        action: "auth.logout",
        targetType: null,
        targetId: null,
        actorType: "operator",
        actorUserId: null,
        actorTokenId: null,
        actorLabel: "operator@example.com",
        ip: null,
        userAgent: null,
        method: "POST",
        path: "/v1/auth/logout",
        statusCode: 204,
        metadata: null,
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      },
    );

    const read = async (action: string): Promise<string[]> => {
      const response = await app.request(`/v1/audit-logs?action=${encodeURIComponent(action)}`, {
        headers: { cookie: operatorCookie({ isAdmin: true }) },
      });
      expect(response.status).toBe(200);
      return (await response.json()).items.map((item: { action: string }) => item.action);
    };

    // A sign-in filter has to include the rejected attempts without also
    // sweeping up sign-outs.
    expect((await read("auth.login")).sort()).toEqual(["auth.login", "auth.login.denied"]);
    expect(await read("message.approve")).toEqual(["message.approve"]);
    expect((await read("auth.")).length).toBe(3);
  });

  it("pages over rows sharing a timestamp without duplicates or gaps", async () => {
    const app = createApp();
    seedAtSameInstant(5, "22222222-2222-4222-8222-222222222222");

    const seen = await drain(app, "/v1/audit-logs?limit=2");

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("pages the per-target trail the same way", async () => {
    const app = createApp();
    const targetId = "33333333-3333-4333-8333-333333333333";
    seedAtSameInstant(5, targetId);

    const seen = await drain(app, `/v1/audit-logs/targets/message/${targetId}?limit=2`);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("rejects a forged cursor rather than passing it to the database", async () => {
    const app = createApp();
    const forged = Buffer.from("2026-07-20T12:00:00.000Z\tnot-a-uuid", "utf8").toString(
      "base64url",
    );

    for (const path of ["/v1/audit-logs", "/v1/audit-logs/targets/message/x"]) {
      const response = await app.request(`${path}?cursor=${forged}`, {
        headers: { cookie: operatorCookie({ isAdmin: true }) },
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_cursor");
    }
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
