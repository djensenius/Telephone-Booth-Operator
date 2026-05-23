import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeDb, store } = vi.hoisted(() => {
  const users = new Map<string, Record<string, unknown>>();
  return {
    store: { users },
    fakeDb: {
      operatorUser: {
        upsert: vi.fn(async ({ where, create, update }) => {
          const existing = users.get(where.oidcSub);
          const next = existing ? { ...existing, ...update } : { firstSeenAt: new Date(), ...create };
          users.set(where.oidcSub, next);
          return next;
        }),
      },
    },
  };
});

vi.mock("../src/lib/db.js", () => ({ db: fakeDb }));

vi.mock("../src/lib/oidc.js", () => ({
  getOidcClient: vi.fn(async () => ({
    serverMetadata: () => ({ jwks_uri: "https://idp.example/jwks.json" }),
  })),
  refreshTokens: vi.fn(),
  exchangeCode: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  endSessionUrl: vi.fn(),
}));

import { errors as joseErrors } from "jose";
import {
  __setBearerVerifierForTests,
  resetBearerAuthForTests,
  verifyOperatorBearer,
} from "../src/lib/bearer-auth.js";
import { resetAuthConfigForTests } from "../src/lib/config.js";

type FakeKey = { kid?: string };

const SIGNING_KEY: FakeKey = { kid: "test-key" };
const FRESH_CLAIMS = {
  iss: "https://idp.example",
  sub: "mobile-user-1",
  aud: "mobile-client",
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "operator@example.com",
  name: "Mobile Operator",
  groups: ["operators"],
};

const setupEnv = () => {
  process.env.OIDC_ISSUER = "https://idp.example";
  process.env.OIDC_CLIENT_ID = "client-id";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_REDIRECT_URI = "http://localhost/v1/auth/callback";
  process.env.OIDC_ALLOWED_GROUPS = "operators";
  process.env.OIDC_MOBILE_AUDIENCES = "mobile-client";
  delete process.env.OIDC_ALLOWED_EMAILS;
  delete process.env.AUTH_DISABLED;
  resetAuthConfigForTests();
  resetBearerAuthForTests();
};

const installVerifier = (
  jwtVerifyMock: (token: string, key: unknown, options: { audience?: string[]; issuer?: string }) => Promise<{ payload: Record<string, unknown> }>,
) => {
  __setBearerVerifierForTests({
    jwks: () => SIGNING_KEY as unknown as never,
    jwtVerify: jwtVerifyMock as unknown as typeof import("jose").jwtVerify,
  });
};

describe("verifyOperatorBearer", () => {
  beforeEach(() => {
    store.users.clear();
    setupEnv();
  });

  it("rejects malformed bearer tokens with 401", async () => {
    installVerifier(async () => {
      throw new joseErrors.JWSInvalid("bad signature");
    });

    const result = await verifyOperatorBearer("not-a-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toBe("invalid_token");
    }
  });

  it("rejects when audience does not match the configured client list", async () => {
    installVerifier(async (_token, _key, options) => {
      const allowed = options.audience as string[] | undefined;
      if (!allowed?.includes("intruder-client")) {
        throw new joseErrors.JWTClaimValidationFailed("unexpected aud claim", "aud", "unexpected_aud");
      }
      return { payload: { ...FRESH_CLAIMS, aud: "intruder-client" } };
    });

    const result = await verifyOperatorBearer("token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects when the issuer does not match", async () => {
    installVerifier(async (_token, _key, options) => {
      if (options.issuer !== "https://attacker.example") {
        throw new joseErrors.JWTClaimValidationFailed("unexpected iss claim", "iss", "unexpected_iss");
      }
      return { payload: { ...FRESH_CLAIMS, iss: "https://attacker.example" } };
    });

    const result = await verifyOperatorBearer("token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 403 when the principal is not in an allowed group", async () => {
    installVerifier(async () => ({
      payload: { ...FRESH_CLAIMS, groups: ["civilians"] },
    }));

    const result = await verifyOperatorBearer("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toMatch(/group/);
    }
  });

  it("returns 403 when the email is not in the allow list", async () => {
    process.env.OIDC_ALLOWED_EMAILS = "someone-else@example.com";
    resetAuthConfigForTests();
    installVerifier(async () => ({ payload: FRESH_CLAIMS }));

    const result = await verifyOperatorBearer("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toMatch(/email/);
    }
  });

  it("upserts the operator user and returns it on a successful verification", async () => {
    installVerifier(async () => ({ payload: FRESH_CLAIMS }));

    const result = await verifyOperatorBearer("token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toMatchObject({
        id: "mobile-user-1",
        email: "operator@example.com",
        name: "Mobile Operator",
      });
      expect(store.users.has("mobile-user-1")).toBe(true);
      const upsertedRow = store.users.get("mobile-user-1") as Record<string, unknown>;
      // `lastLoginAt` is only set on interactive logins, not bearer requests
      expect(upsertedRow.lastSeenAt).toBeInstanceOf(Date);
    }
    expect(fakeDb.operatorUser.upsert).toHaveBeenCalledTimes(1);
  });

  it("does NOT update lastLoginAt on a bearer request that hits an existing user", async () => {
    // Seed an existing user, then re-verify the same subject
    installVerifier(async () => ({ payload: FRESH_CLAIMS }));
    const first = await verifyOperatorBearer("token");
    expect(first.ok).toBe(true);

    const initialLoginAt = (store.users.get("mobile-user-1") as { lastLoginAt: Date }).lastLoginAt;
    // Tick time forward so we can verify lastLoginAt is unchanged
    await new Promise((r) => setTimeout(r, 5));

    const second = await verifyOperatorBearer("token");
    expect(second.ok).toBe(true);
    const after = store.users.get("mobile-user-1") as { lastLoginAt: Date; lastSeenAt: Date };
    expect(after.lastLoginAt).toEqual(initialLoginAt);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(initialLoginAt.getTime());
  });
});
