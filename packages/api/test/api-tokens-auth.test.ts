import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../src/index.js";
import { resetApiTokenStateForTests } from "../src/lib/api-tokens.js";

const { fakeDb, store } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, Record<string, unknown>>();

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });
  const selectFields = (
    row: Record<string, unknown>,
    select: Record<string, boolean> | undefined,
  ) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row);

  return {
    store: { users, sessions, tokens },
    fakeDb: {
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
          const row = {
            id: randomUUID(),
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
            ...data,
          };
          tokens.set(row.id, row);
          return selectFields(row, select);
        }),
        findMany: vi.fn(async () => []),
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
        updateMany: vi.fn(async () => ({ count: 0 })),
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

describe("api token auth", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = sessionSecret;
    store.users.clear();
    store.sessions.clear();
    store.tokens.clear();
    resetApiTokenStateForTests();
  });

  it("requires a cookie-authenticated operator for token mutations", async () => {
    const app = createApp();
    const create = await app.request("/v1/api-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No Cookie" }),
    });
    expect(create.status).toBe(401);

    const revoke = await app.request(`/v1/api-tokens/${randomUUID()}`, { method: "DELETE" });
    expect(revoke.status).toBe(401);
  });

  it("never returns tokenHash or lookupId when creating a token", async () => {
    const app = createApp();
    const cookie = seedSession();
    const create = await app.request("/v1/api-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Booth Pi" }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const body = (await create.json()) as Record<string, unknown>;
    expect(body.plaintext).toMatch(/^tb_/);
    expect(body).not.toHaveProperty("tokenHash");
    expect(body).not.toHaveProperty("hash");
    expect(body).not.toHaveProperty("lookupId");
    expect(JSON.stringify(body)).not.toContain(
      String(store.tokens.values().next().value?.tokenHash),
    );
  });
});
