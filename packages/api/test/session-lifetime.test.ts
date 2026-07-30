import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Covers the "remember me" behaviour of operator sessions: the idle window
// slides forward on activity (bounded by an absolute ceiling), and a token
// refresh that fails for a transient reason must not log the operator out.

const { fakeDb, openidMocks, store, FakeChallengeError, FakeResponseBodyError } = vi.hoisted(() => {
  class FakeChallengeError extends Error {
    override name = "WWWAuthenticateChallengeError";
  }
  class FakeResponseBodyError extends Error {
    override name = "ResponseBodyError";
    error: string;
    status: number;
    constructor(error: string, status: number) {
      super(error);
      this.error = error;
      this.status = status;
    }
  }
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();

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
        groups: ["operators"],
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
    store: { users, sessions },
    FakeChallengeError,
    FakeResponseBodyError,
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
  ResponseBodyError: FakeResponseBodyError,
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
import {
  resetSessionCryptoForTests,
  resetSessionRefreshStateForTests,
} from "../src/lib/session.js";
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

const login = async (): Promise<string> => {
  const start = await app.request("/v1/auth/login");
  const txCookie = loginTxCookieFrom(start);
  const callback = await app.request(
    "http://127.0.0.1/v1/auth/callback?code=code-1&state=state-1",
    { headers: { cookie: txCookie } },
  );
  return cookieFrom(callback);
};

const expireAccessToken = (): void => {
  onlySession().accessTokenExpiresAt = new Date(Date.now() - 1000);
};

const sessionCookieExpiry = (res: Response): Date | null => {
  for (const entry of res.headers.getSetCookie()) {
    if (!entry.startsWith("__Host-booth_session=") && !entry.startsWith("booth_session=")) continue;
    const expires = /Expires=([^;]+)/.exec(entry)?.[1];
    if (expires) return new Date(expires);
  }
  return null;
};

const configure = (overrides: Record<string, string> = {}): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SESSION_TTL_SECONDS = "86400";
  process.env.SESSION_ABSOLUTE_TTL_SECONDS = "0";
  process.env.SESSION_REVALIDATE_SECONDS = "300";
  process.env.OIDC_ISSUER = "https://idp.example";
  process.env.OIDC_CLIENT_ID = "client-id";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
  process.env.OIDC_ALLOWED_GROUPS = "operators";
  process.env.OIDC_ADMIN_GROUPS = "admins";
  delete process.env.AUTH_DISABLED;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetAuthConfigForTests();
  resetOidcForTests();
  resetAuthRouteStateForTests();
  resetSessionCryptoForTests();
  resetSessionRefreshStateForTests();
};

describe("sliding operator session lifetime", () => {
  beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    openidMocks.authorizationCodeGrant.mockClear();
    openidMocks.refreshTokenGrant.mockClear();
    openidMocks.fetchUserInfo.mockClear();
    configure();
  });

  it("extends the idle window when the session is used", async () => {
    const cookie = await login();
    const session = onlySession();
    // Simulate most of the idle window having elapsed since the last renewal.
    session.expiresAt = new Date(Date.now() + 60 * 1000);

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    const extended = onlySession().expiresAt as Date;
    expect(extended.getTime()).toBeGreaterThan(Date.now() + 86_000 * 1000);
    // The browser cookie must slide with the row, or it is dropped first.
    const cookieExpiry = sessionCookieExpiry(me);
    expect(cookieExpiry?.getTime() ?? 0).toBeGreaterThan(Date.now() + 86_000 * 1000);
  });

  it("does not rewrite the session on every request", async () => {
    const cookie = await login();
    const before = onlySession().expiresAt as Date;

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect((onlySession().expiresAt as Date).getTime()).toBe(before.getTime());
    expect(sessionCookieExpiry(me)).toBeNull();
  });

  it("caps the sliding window at the absolute lifetime", async () => {
    configure({ SESSION_ABSOLUTE_TTL_SECONDS: "7200" });
    const cookie = await login();
    const session = onlySession();
    session.createdAt = new Date(Date.now() - 1800 * 1000);
    session.expiresAt = new Date(Date.now() + 60 * 1000);

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    const extended = (onlySession().expiresAt as Date).getTime();
    // createdAt + 7200s, i.e. 90 minutes from now — not the full idle TTL.
    expect(extended).toBeLessThanOrEqual(Date.now() + 5400 * 1000 + 5_000);
    expect(extended).toBeGreaterThan(Date.now() + 5300 * 1000);
  });

  it("expires a session that has been idle past its window", async () => {
    const cookie = await login();
    onlySession().expiresAt = new Date(Date.now() - 1000);

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it("enforces an absolute deadline that a stored expiry outlives", async () => {
    // A session created before the ceiling was enabled (or under a longer one)
    // still carries a future `expiresAt`; the ceiling must bind anyway.
    const cookie = await login();
    const session = onlySession();
    session.createdAt = new Date(Date.now() - 8000 * 1000);
    session.expiresAt = new Date(Date.now() + 86400 * 1000);
    configure({ SESSION_ABSOLUTE_TTL_SECONDS: "7200" });

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });
});

describe("token refresh failures", () => {
  beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    openidMocks.authorizationCodeGrant.mockClear();
    openidMocks.refreshTokenGrant.mockClear();
    openidMocks.fetchUserInfo.mockClear();
    configure();
  });

  it("refreshes an expired access token", async () => {
    const cookie = await login();
    expireAccessToken();

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(openidMocks.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(store.sessions.size).toBe(1);
  });

  it("keeps the session when the provider is unreachable", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(new TypeError("fetch failed"));

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });

  it("keeps the session when the provider returns a 5xx", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(
      new FakeResponseBodyError("server_error", 503),
    );

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });

  it("does not spend a stale access token on IdP revalidation", async () => {
    const cookie = await login();
    expireAccessToken();
    onlySession().lastValidatedAt = new Date(Date.now() - 10 * 60 * 1000);
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(new TypeError("fetch failed"));

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(openidMocks.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("keeps the session when the provider rate limits the refresh", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(
      new FakeResponseBodyError("temporarily_unavailable", 429),
    );

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });

  it("keeps the session on a 4xx that is not about the refresh token", async () => {
    const cookie = await login();
    expireAccessToken();
    // `invalid_client` is a client-credentials problem: the refresh token may
    // still be perfectly good once the misconfiguration is resolved.
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(
      new FakeResponseBodyError("invalid_client", 401),
    );

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });

  it("signs out when the provider rejects the refresh token", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(
      new FakeResponseBodyError("invalid_grant", 400),
    );

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it("keeps the session when a sibling replica wins the rotation", async () => {
    // Refresh-token rotation across replicas: another replica spent the same
    // stored token first, so this one is refused. Its rotated pair lands just
    // after our immediate reread — the delayed second reread must find it
    // rather than destroying a session that is about to be healthy.
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockImplementationOnce(async () => {
      setTimeout(() => {
        onlySession().accessTokenExpiresAt = new Date(Date.now() + 300 * 1000);
      }, 50);
      throw new FakeResponseBodyError("invalid_grant", 400);
    });

    const me = await app.request("/v1/auth/me", { headers: { cookie } });

    expect(me.status).toBe(200);
    expect(store.sessions.size).toBe(1);
  });

  it("does not hammer the provider while it is failing", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(new TypeError("fetch failed"));

    await app.request("/v1/auth/me", { headers: { cookie } });
    const second = await app.request("/v1/auth/me", { headers: { cookie } });

    // The second request is still inside the backoff, so it serves the session
    // with its stale access token instead of starting another grant.
    expect(second.status).toBe(200);
    expect(openidMocks.refreshTokenGrant).toHaveBeenCalledTimes(1);
  });

  it("retries the refresh once the backoff lapses", async () => {
    const cookie = await login();
    expireAccessToken();
    openidMocks.refreshTokenGrant.mockRejectedValueOnce(new TypeError("fetch failed"));
    await app.request("/v1/auth/me", { headers: { cookie } });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const second = await app.request("/v1/auth/me", { headers: { cookie } });

      expect(second.status).toBe(200);
      expect(openidMocks.refreshTokenGrant).toHaveBeenCalledTimes(2);
      expect(onlySession().accessTokenExpiresAt).toBeInstanceOf(Date);
      expect((onlySession().accessTokenExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});
