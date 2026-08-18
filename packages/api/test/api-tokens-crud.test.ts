import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import { createApp } from "../src/index.js";
import { flushApiTokenUsageUpdates, resetApiTokenStateForTests } from "../src/lib/api-tokens.js";
import { requireApiToken, type ApiTokenVariables } from "../src/lib/require-api-token.js";

const { fakeDb, store } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();
  const telemetrySources = new Map<string, Record<string, unknown>>();

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });

  const selectFields = (
    row: Record<string, unknown>,
    select: Record<string, boolean | { select: Record<string, boolean> }> | undefined,
  ) => {
    if (!select) return row;
    return Object.fromEntries(
      Object.entries(select).map(([key, selection]) => {
        if (selection === true) return [key, row[key]];
        if (key === "telemetrySource") {
          const sourceId = row.telemetrySourceId;
          const source = typeof sourceId === "string" ? telemetrySources.get(sourceId) : undefined;
          return [key, source ? selectFields(source, selection.select) : null];
        }
        return [key, row[key]];
      }),
    );
  };

  return {
    store: { users, sessions, tokens, telemetrySources },
    fakeDb: {
      // Audit rows are written by middleware on every write; these suites do
      // not assert on them, they just need the delegate to exist.
      auditLog: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
      operatorSession: {
        findUnique: vi.fn(async ({ where, include }) => {
          const session = sessions.get(where.id);
          if (!session) return null;
          return include?.user ? withUser(session) : session;
        }),
        update: vi.fn(async ({ where, data, include }) => {
          const session = sessions.get(where.id);
          if (!session) throw new Error("missing session");
          const next = { ...session, ...data };
          sessions.set(where.id, next);
          return include?.user ? withUser(next) : next;
        }),
      },
      apiToken: {
        create: vi.fn(async ({ data, select }) => {
          const relation = data.telemetrySource as
            | {
                connectOrCreate: {
                  where: { boothId_componentId: { boothId: string; componentId: string } };
                  create: Record<string, unknown>;
                };
              }
            | undefined;
          let telemetrySourceId: string | null = null;
          if (relation) {
            const identity = relation.connectOrCreate.where.boothId_componentId;
            let source = [...telemetrySources.values()].find(
              (candidate) =>
                candidate.boothId === identity.boothId &&
                candidate.componentId === identity.componentId,
            );
            if (!source) {
              source = {
                id: randomUUID(),
                latestSnapshot: null,
                capturedAt: null,
                receivedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...relation.connectOrCreate.create,
              };
              telemetrySources.set(source.id as string, source);
            }
            telemetrySourceId = source.id as string;
          }
          const createdBy = data.createdBy as { connect: { id: string } };
          const { telemetrySource: _telemetrySource, createdBy: _createdBy, ...scalarData } = data;
          const row = {
            id: randomUUID(),
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
            telemetrySourceId,
            createdByUserId: createdBy.connect.id,
            ...scalarData,
          };
          tokens.set(row.id, row);
          return selectFields(row, select);
        }),
        findMany: vi.fn(async ({ where, select }) =>
          Array.from(tokens.values())
            .filter((token) => token.createdByUserId === where.createdByUserId)
            .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
            .map((token) => selectFields(token, select)),
        ),
        findUnique: vi.fn(async ({ where }) => {
          if (where.id) return tokens.get(where.id) ?? null;
          return (
            Array.from(tokens.values()).find((token) => token.lookupId === where.lookupId) ?? null
          );
        }),
        findFirst: vi.fn(async ({ where, select }) => {
          const row = Array.from(tokens.values()).find(
            (token) => token.id === where.id && token.createdByUserId === where.createdByUserId,
          );
          return row ? selectFields(row, select) : null;
        }),
        update: vi.fn(async ({ where, data }) => {
          const row = tokens.get(where.id);
          if (!row) throw new Error("missing token");
          const next = { ...row, ...data };
          tokens.set(where.id, next);
          return next;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          let count = 0;
          for (const [id, token] of tokens.entries()) {
            if (token.id !== where.id || token.createdByUserId !== where.createdByUserId) continue;
            if (where.revokedAt === null && token.revokedAt !== null) continue;
            tokens.set(id, { ...token, ...data });
            count += 1;
          }
          return { count };
        }),
      },
    },
  };
});

vi.mock("../src/lib/db.js", () => ({ db: fakeDb }));

const sessionSecret = "test-session-secret";
const cookieForSession = (sessionId: string): string => {
  const signature = createHmac("sha256", sessionSecret).update(sessionId).digest("base64url");
  return `__Host-booth_session=${sessionId}.${signature}`;
};

const seedSession = (): string => {
  const user = {
    id: "user-1",
    oidcSub: "user-1",
    email: "operator@example.com",
    name: "Operator",
    groups: [],
  };
  store.users.set(user.id, user);
  store.sessions.set("session-1", {
    id: "session-1",
    userId: user.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  });
  return cookieForSession("session-1");
};

describe("api token CRUD", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = sessionSecret;
    store.users.clear();
    store.sessions.clear();
    store.tokens.clear();
    store.telemetrySources.clear();
    resetApiTokenStateForTests();
  });

  it("creates, lists, uses, revokes, and rejects a token", async () => {
    const cookie = seedSession();
    const app = createApp();

    const create = await app.request("/v1/api-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Booth Pi", expiresInDays: 1 }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const created = (await create.json()) as {
      id: string;
      plaintext: string;
      last4: string;
      name: string;
    };
    expect(created.name).toBe("Booth Pi");
    expect(created.plaintext).toMatch(/^tb_[A-Za-z0-9_-]{32}$/);
    expect(created.last4).toBe(created.plaintext.slice(-4));

    const list = await app.request("/v1/api-tokens", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject([
      { id: created.id, name: "Booth Pi", last4: created.last4 },
    ]);

    const phoneApp = new Hono<{ Variables: ApiTokenVariables }>();
    phoneApp.get("/phone", requireApiToken(), (c) => c.json({ tokenId: c.get("apiTokenId") }));
    const use = await phoneApp.request("/phone", {
      headers: { authorization: `Bearer ${created.plaintext}` },
    });
    expect(use.status, await use.clone().text()).toBe(200);
    await expect(use.json()).resolves.toEqual({ tokenId: created.id });
    await flushApiTokenUsageUpdates();

    const revoke = await app.request(`/v1/api-tokens/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoke.status).toBe(204);
    expect(store.tokens.get(created.id)?.revokedAt).toBeInstanceOf(Date);

    const rejected = await phoneApp.request("/phone", {
      headers: { authorization: `Bearer ${created.plaintext}` },
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "invalid_token" });
  });

  it("enforces token scope on scoped routes", async () => {
    const cookie = seedSession();
    const app = createApp();

    const createScoped = async (name: string, scope: "operator" | "worker"): Promise<string> => {
      const res = await app.request("/v1/api-tokens", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name, scope }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as { plaintext: string; scope: string };
      expect(body.scope).toBe(scope);
      return body.plaintext;
    };

    const workerToken = await createScoped("Transcription worker", "worker");
    const operatorToken = await createScoped("Booth Pi", "operator");

    const workerApp = new Hono<{ Variables: ApiTokenVariables }>();
    workerApp.get("/work", requireApiToken("worker"), (c) =>
      c.json({ scope: c.get("apiToken").scope }),
    );

    const accepted = await workerApp.request("/work", {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ scope: "worker" });

    const forbidden = await workerApp.request("/work", {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "insufficient_scope" });

    // Booth/phone routes default to the "operator" scope, so a worker token
    // must be rejected there too (least-privilege boundary).
    const phoneApp = new Hono<{ Variables: ApiTokenVariables }>();
    phoneApp.get("/phone", requireApiToken(), (c) => c.json({ ok: true }));

    const phoneWithWorker = await phoneApp.request("/phone", {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(phoneWithWorker.status).toBe(403);
    await expect(phoneWithWorker.json()).resolves.toEqual({ error: "insufficient_scope" });

    const phoneWithOperator = await phoneApp.request("/phone", {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(phoneWithOperator.status, await phoneWithOperator.clone().text()).toBe(200);
  });

  it("binds telemetry token rotations to one persistent source", async () => {
    const cookie = seedSession();
    const app = createApp();
    const telemetrySource = {
      boothId: "booth-01",
      componentId: "router-01",
      displayName: "Router",
      kind: "router",
      prometheusJob: "glinet-router",
      prometheusInstance: "router-01",
    };

    const issue = async (name: string, displayName = telemetrySource.displayName) => {
      const response = await app.request("/v1/api-tokens", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name,
          scope: "telemetry",
          telemetrySource: { ...telemetrySource, displayName },
        }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json();
    };

    await expect(issue("Router telemetry")).resolves.toMatchObject({
      scope: "telemetry",
      telemetrySource,
    });
    await expect(issue("Router telemetry rotation", "Ignored replacement")).resolves.toMatchObject({
      scope: "telemetry",
      telemetrySource,
    });
    expect(store.telemetrySources).toHaveLength(1);
    expect(
      new Set([...store.tokens.values()].map((token) => token.telemetrySourceId)),
    ).toHaveLength(1);

    const list = await app.request("/v1/api-tokens", { headers: { cookie } });
    expect(list.status).toBe(200);
    const summaries = (await list.json()) as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(2);
    expect(summaries.every((summary) => "telemetrySource" in summary)).toBe(true);
  });
});
