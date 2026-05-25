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

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });

  const selectFields = (
    row: Record<string, unknown>,
    select: Record<string, boolean> | undefined,
  ) => {
    if (!select) return row;
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
  };

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
});
