import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Verifies that active operator sessions are periodically re-checked against
// the IdP (userinfo). An account deleted or removed from the operator group in
// Authentik must stop working within SESSION_REVALIDATE_SECONDS instead of
// surviving for the full session TTL, and admin-only routes must be gated on
// the operator's admin-group membership.

const { fakeDb, openidMocks, store, FakeChallengeError } = vi.hoisted(() => {
  class FakeChallengeError extends Error {
    override name = "WWWAuthenticateChallengeError";
  }
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const files = new Map<string, Record<string, unknown>>();
  const questions = new Map<string, Record<string, unknown>>();

  let loginGroups: string[] = ["operators"];

  const tokenSet = () => {
    const result = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      id_token: "id-token",
      token_type: "bearer",
      expires_in: 300,
      expiresIn: () => 300,
    };
    Object.defineProperty(result, "claims", {
      value: () => ({
        iss: "https://idp.example",
        sub: "oidc-sub-1",
        aud: "client-id",
        iat: 1,
        exp: 9999999999,
        nonce: "nonce-1",
        email: "operator@example.com",
        name: "Operator One",
        groups: loginGroups,
      }),
      writable: false,
    });
    return result;
  };

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });

  return {
    store: {
      users,
      sessions,
      files,
      questions,
      setLoginGroups: (groups: string[]) => {
        loginGroups = groups;
      },
    },
    FakeChallengeError,
    openidMocks: {
      authorizationCodeGrant: vi.fn(async () => tokenSet()),
      refreshTokenGrant: vi.fn(async () => tokenSet()),
      fetchUserInfo: vi.fn(async () => ({
        sub: "oidc-sub-1",
        email: "operator@example.com",
        name: "Operator One",
        groups: ["operators"],
      })),
    },
    fakeDb: {
      operatorUser: {
        upsert: vi.fn(async ({ where, create, update }) => {
          const existing = users.get(where.oidcSub);
          const next = existing
            ? { ...existing, ...update }
            : { firstSeenAt: new Date(), ...create };
          users.set(where.oidcSub, next);
          return next;
        }),
      },
      operatorSession: {
        create: vi.fn(async ({ data }) => {
          const session = { createdAt: new Date(), lastSeenAt: new Date(), ...data };
          sessions.set(data.id, session);
          return session;
        }),
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
        delete: vi.fn(async ({ where }) => {
          const session = sessions.get(where.id);
          sessions.delete(where.id);
          return session;
        }),
      },
      file: {
        findUnique: vi.fn(async ({ where }) => files.get(where.id) ?? null),
      },
      question: {
        create: vi.fn(async ({ data }) => {
          const question = {
            id: "q-1",
            createdAt: new Date(),
            retiredAt: null,
            ...data,
            audio: files.get(data.audioId) ?? null,
          };
          questions.set(question.id, question);
          return question;
        }),
      },
      // Question creation tags the row with the active installation and then
      // re-reads it to confirm the era did not close underneath the insert, so
      // this minimal mock needs both lookups.
      installation: {
        findFirst: vi.fn(async () => ({
          id: "00000000-0000-4000-8000-0000000000ff",
          name: "Installation 1",
          notes: null,
          location: null,
          startedAt: new Date(),
          endedAt: null,
          endedById: null,
          summary: null,
          createdAt: new Date(),
        })),
        findUnique: vi.fn(async () => ({ endedAt: null })),
        count: vi.fn(async () => 1),
      },
    },
  };
});

vi.mock("../src/lib/db.js", () => ({ db: fakeDb }));

vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

vi.mock("openid-client", () => ({
  randomState: () => "state-1",
  randomNonce: () => "nonce-1",
  randomPKCECodeVerifier: () => "verifier-1",
  ClientSecretPost: () => vi.fn(),
  allowInsecureRequests: vi.fn(),
  skipSubjectCheck: Symbol("skipSubjectCheck"),
  WWWAuthenticateChallengeError: FakeChallengeError,
  ResponseBodyError: class ResponseBodyError extends Error {},
  discovery: vi.fn(async () => ({
    serverMetadata: () => ({ end_session_endpoint: "https://idp.example/logout" }),
  })),
  buildAuthorizationUrl: vi.fn((_config, params) => {
    const url = new URL("https://idp.example/authorize");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url;
  }),
  authorizationCodeGrant: openidMocks.authorizationCodeGrant,
  refreshTokenGrant: openidMocks.refreshTokenGrant,
  fetchUserInfo: openidMocks.fetchUserInfo,
  buildEndSessionUrl: vi.fn(() => new URL("https://idp.example/logout")),
}));

import { app } from "../src/index.js";
import { resetAuthConfigForTests } from "../src/lib/config.js";
import { resetOidcForTests } from "../src/lib/oidc.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetAuthRouteStateForTests } from "../src/routes/auth.js";

const cookieFrom = (res: Response): string => {
  for (const entry of res.headers.getSetCookie()) {
    if (entry.startsWith("__Host-booth_session=")) return entry.split(";")[0] ?? entry;
  }
  for (const entry of res.headers.getSetCookie()) {
    if (entry.startsWith("booth_session=")) return entry.split(";")[0] ?? entry;
  }
  throw new Error("missing session cookie");
};

const loginTxCookieFrom = (res: Response): string => {
  for (const entry of res.headers.getSetCookie()) {
    if (entry.startsWith("__Host-booth_login_tx=")) return entry.split(";")[0] ?? entry;
    if (entry.startsWith("booth_login_tx=")) return entry.split(";")[0] ?? entry;
  }
  throw new Error("missing login-tx cookie");
};

const onlySession = (): Record<string, unknown> => {
  const session = store.sessions.values().next().value;
  if (!session) throw new Error("missing session");
  return session;
};

const login = async (groups: string[]): Promise<string> => {
  store.setLoginGroups(groups);
  const start = await app.request("/v1/auth/login");
  const txCookie = loginTxCookieFrom(start);
  const callback = await app.request(
    "http://127.0.0.1/v1/auth/callback?code=code-1&state=state-1",
    { headers: { cookie: txCookie } },
  );
  return cookieFrom(callback);
};

const staleSession = (): void => {
  const session = onlySession();
  session.lastValidatedAt = new Date(Date.now() - 10 * 60 * 1000);
};

describe("session revalidation against the IdP", () => {
  beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    store.files.clear();
    store.questions.clear();
    store.setLoginGroups(["operators"]);
    openidMocks.authorizationCodeGrant.mockClear();
    openidMocks.refreshTokenGrant.mockClear();
    openidMocks.fetchUserInfo.mockClear();
    openidMocks.fetchUserInfo.mockResolvedValue({
      sub: "oidc-sub-1",
      email: "operator@example.com",
      name: "Operator One",
      groups: ["operators"],
    });
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "test-session-secret";
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.SESSION_TTL_SECONDS = "43200";
    process.env.SESSION_REVALIDATE_SECONDS = "300";
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client-id";
    process.env.OIDC_CLIENT_SECRET = "client-secret";
    process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
    process.env.OIDC_ALLOWED_GROUPS = "operators";
    process.env.OIDC_ADMIN_GROUPS = "admins";
    delete process.env.AUTH_DISABLED;
    resetAuthConfigForTests();
    resetOidcForTests();
    resetAuthRouteStateForTests();
    resetSessionCryptoForTests();
  });

  it("does not re-check the IdP while the session is fresh", async () => {
    const cookie = await login(["operators"]);
    const me = await app.request("/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(openidMocks.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("re-checks the IdP once the revalidation interval has elapsed", async () => {
    const cookie = await login(["operators"]);
    staleSession();

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(openidMocks.fetchUserInfo).toHaveBeenCalledTimes(1);
    expect(store.sessions.size).toBe(1);
  });

  it("signs out an account that was deleted at the IdP", async () => {
    const cookie = await login(["operators"]);
    staleSession();
    // Userinfo returns a 401 challenge when the account no longer exists.
    openidMocks.fetchUserInfo.mockRejectedValueOnce(new FakeChallengeError("deleted"));

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it("signs out an operator removed from the operator group", async () => {
    const cookie = await login(["operators"]);
    staleSession();
    // Account still exists but is no longer in an authorized group.
    openidMocks.fetchUserInfo.mockResolvedValueOnce({
      sub: "oidc-sub-1",
      email: "operator@example.com",
      name: "Operator One",
      groups: ["former-operators"],
    });

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it("keeps the session on a transient IdP failure", async () => {
    const cookie = await login(["operators"]);
    staleSession();
    openidMocks.fetchUserInfo.mockRejectedValueOnce(new TypeError("network down"));

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });
});

describe("operator admin tier", () => {
  beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    store.files.clear();
    store.questions.clear();
    openidMocks.authorizationCodeGrant.mockClear();
    openidMocks.fetchUserInfo.mockClear();
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "test-session-secret";
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.SESSION_TTL_SECONDS = "43200";
    process.env.SESSION_REVALIDATE_SECONDS = "300";
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client-id";
    process.env.OIDC_CLIENT_SECRET = "client-secret";
    process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
    process.env.OIDC_ALLOWED_GROUPS = "operators";
    process.env.OIDC_ADMIN_GROUPS = "admins";
    delete process.env.AUTH_DISABLED;
    resetAuthConfigForTests();
    resetOidcForTests();
    resetAuthRouteStateForTests();
    resetSessionCryptoForTests();
  });

  it("reports isAdmin=false for a non-admin operator", async () => {
    const cookie = await login(["operators"]);
    const me = await app.request("/v1/auth/me", { headers: { cookie } });
    await expect(me.json()).resolves.toMatchObject({ isAdmin: false });
  });

  it("reports isAdmin=true for an operator in the admin group", async () => {
    const cookie = await login(["operators", "admins"]);
    const me = await app.request("/v1/auth/me", { headers: { cookie } });
    await expect(me.json()).resolves.toMatchObject({ isAdmin: true });
  });

  it("forbids a non-admin from creating a question", async () => {
    const cookie = await login(["operators"]);
    store.files.set("file-1", { id: "file-1" });

    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Who calls the booth?", audioFileId: "file-1" }),
    });

    expect(res.status).toBe(403);
    expect(store.questions.size).toBe(0);
  });

  it("allows an admin to create a question", async () => {
    const cookie = await login(["operators", "admins"]);
    const fileId = "44444444-4444-4444-8444-444444444444";
    store.files.set(fileId, {
      id: fileId,
      blobKey: "audio/file-1.flac",
      sha256: "abc",
      durationMs: 1000,
    });

    const res = await app.request("/v1/questions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Who calls the booth?", audioFileId: fileId }),
    });

    expect(res.status, await res.clone().text()).toBe(201);
    expect(store.questions.size).toBe(1);
  });
});
