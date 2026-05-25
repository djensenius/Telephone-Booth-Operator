import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fakeDb, openidMocks, store } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();

  const withUser = (session: Record<string, unknown>) => ({
    ...session,
    user: users.get(session.userId as string),
  });

  return {
    store: { users, sessions },
    openidMocks: {
      authorizationCodeGrant: vi.fn(async () => {
        const tokenSet = {
          access_token: "access-token",
          refresh_token: "refresh-token",
          id_token: "id-token",
          token_type: "bearer",
          expires_in: 3600,
          expiresIn: () => 3600,
        };
        Object.defineProperty(tokenSet, "claims", {
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
            picture: "https://example.com/avatar.png",
          }),
          writable: false,
        });
        return tokenSet;
      }),
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

vi.mock("openid-client", () => ({
  randomState: () => "state-1",
  randomNonce: () => "nonce-1",
  randomPKCECodeVerifier: () => "verifier-1",
  ClientSecretPost: () => vi.fn(),
  allowInsecureRequests: vi.fn(),
  discovery: vi.fn(async () => ({
    serverMetadata: () => ({ end_session_endpoint: "https://idp.example/logout" }),
  })),
  buildAuthorizationUrl: vi.fn((_config, params) => {
    const url = new URL("https://idp.example/authorize");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url;
  }),
  authorizationCodeGrant: openidMocks.authorizationCodeGrant,
  refreshTokenGrant: vi.fn(async () => ({
    access_token: "new-access-token",
    token_type: "bearer",
    expires_in: 3600,
    claims: () => undefined,
    expiresIn: () => 3600,
  })),
  buildEndSessionUrl: vi.fn((_config, params) => {
    const url = new URL("https://idp.example/logout");
    for (const [key, value] of Object.entries(params ?? {}))
      url.searchParams.set(key, String(value));
    return url;
  }),
}));

import { app } from "../src/index.js";
import { resetAuthConfigForTests } from "../src/lib/config.js";
import { resetOidcForTests } from "../src/lib/oidc.js";
import { resetAuthRouteStateForTests } from "../src/routes/auth.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";

const cookieFrom = (res: Response): string => {
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("missing set-cookie");
  return cookie.split(";")[0] ?? cookie;
};

describe("auth flow", () => {
  beforeEach(() => {
    store.users.clear();
    store.sessions.clear();
    openidMocks.authorizationCodeGrant.mockClear();
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "test-session-secret";
    process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client-id";
    process.env.OIDC_CLIENT_SECRET = "client-secret";
    process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
    process.env.OIDC_POST_LOGOUT_REDIRECT_URI = "http://localhost:5173";
    process.env.OIDC_ALLOWED_GROUPS = "operators";
    delete process.env.PUBLIC_WEB_URL;
    delete process.env.WEB_ORIGIN;
    delete process.env.AUTH_DISABLED;
    resetAuthConfigForTests();
    resetOidcForTests();
    resetAuthRouteStateForTests();
    resetSessionCryptoForTests();
  });

  it("handles login, callback, me, and logout", async () => {
    const login = await app.request("/v1/auth/login?return_to=/dashboard");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toContain("https://idp.example/authorize");
    expect(login.headers.get("location")).toContain("state=state-1");

    const callback = await app.request(
      "http://127.0.0.1/v1/auth/callback?code=code-1&state=state-1",
    );
    expect(callback.status, await callback.clone().text()).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost:5173/dashboard");
    expect(openidMocks.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      new URL("http://localhost/v1/auth/callback?code=code-1&state=state-1"),
      expect.objectContaining({
        expectedNonce: "nonce-1",
        expectedState: "state-1",
        pkceCodeVerifier: "verifier-1",
      }),
    );
    const cookie = cookieFrom(callback);
    expect(cookie).toContain("__Host-booth_session=");
    const setCookie = callback.headers.get("set-cookie");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toMatch(/(?:^|, )booth_session=/);

    const me = await app.request("/v1/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      id: "oidc-sub-1",
      email: "operator@example.com",
      name: "Operator One",
      groups: ["operators"],
      picture: "https://example.com/avatar.png",
      providerName: "Authentik",
    });

    const logout = await app.request("/v1/auth/logout", { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toContain("https://idp.example/logout");
    expect(store.sessions.size).toBe(0);
  });
});
