import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetAuthConfigForTests } from "../src/lib/config.js";
import { createApp } from "../src/index.js";
import { validateAuthorization } from "../src/routes/auth.js";

const claims = {
  iss: "https://idp.example",
  sub: "user-1",
  aud: "client",
  iat: 1,
  exp: 9999999999,
  email: "operator@example.com",
};

describe("auth guards", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
    resetAuthConfigForTests();
  });

  it("returns 401 when an operator route has no session cookie", async () => {
    const app = createApp();
    const res = await app.request("/v1/questions");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "unauthenticated",
      login_url: "/v1/auth/login",
    });
  });

  it("enforces allowed email claims", () => {
    process.env.AUTH_DISABLED = "false";
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_REDIRECT_URI = "https://api.example/v1/auth/callback";
    process.env.OIDC_ALLOWED_EMAILS = "other@example.com";
    resetAuthConfigForTests();

    expect(validateAuthorization(claims, ["operators"])).toMatch(/email/);
  });

  it("enforces allowed groups claims", () => {
    process.env.AUTH_DISABLED = "false";
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_REDIRECT_URI = "https://api.example/v1/auth/callback";
    process.env.OIDC_ALLOWED_EMAILS = "operator@example.com";
    process.env.OIDC_ALLOWED_GROUPS = "admins";
    resetAuthConfigForTests();

    expect(validateAuthorization(claims, ["operators"])).toMatch(/group/);
    expect(validateAuthorization(claims, ["admins"])).toBeNull();
  });

  it("rejects access when no allow-lists are configured (fail closed)", () => {
    process.env.AUTH_DISABLED = "false";
    process.env.OIDC_ISSUER = "https://idp.example";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_REDIRECT_URI = "https://api.example/v1/auth/callback";
    delete process.env.OIDC_ALLOWED_EMAILS;
    delete process.env.OIDC_ALLOWED_GROUPS;
    resetAuthConfigForTests();

    expect(validateAuthorization(claims, ["operators"])).toMatch(/allow-list/i);
  });
});
