import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { oidcMocks } = vi.hoisted(() => ({
  oidcMocks: {
    allowInsecureRequests: vi.fn(),
    discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  },
}));

vi.mock("openid-client", () => ({
  ClientSecretPost: () => vi.fn(),
  allowInsecureRequests: oidcMocks.allowInsecureRequests,
  discovery: oidcMocks.discovery,
}));

import {
  assertAuthorizationConfigured,
  assertOidcIssuerAllowed,
  AuthConfigurationError,
  resolveAuthConfig,
  resetAuthConfigForTests,
} from "../src/lib/config.js";
import { getOidcClient, resetOidcForTests } from "../src/lib/oidc.js";

const baseEnv = {
  AUTHENTIK_ISSUER: "https://authentik.example/application/o/booth/",
  AUTHENTIK_CLIENT_ID: "authentik-client",
  AUTHENTIK_CLIENT_SECRET: "authentik-secret",
  AUTHENTIK_REDIRECT_URI: "https://api.example/v1/auth/callback",
  AUTHENTIK_POST_LOGOUT_REDIRECT_URI: "https://web.example",
  AUTHENTIK_ALLOWED_GROUPS: "authentik-group",
};

const httpEnv = {
  ...baseEnv,
  AUTHENTIK_ISSUER: "http://authentik.example/application/o/booth/",
};

const ENV_KEYS = [
  "AUTH_DISABLED",
  "NODE_ENV",
  "OIDC_ALLOW_HTTP_ISSUER",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
  "OIDC_POST_LOGOUT_REDIRECT_URI",
  "OIDC_ALLOWED_GROUPS",
  "AUTHENTIK_ISSUER",
  "AUTHENTIK_CLIENT_ID",
  "AUTHENTIK_CLIENT_SECRET",
  "AUTHENTIK_REDIRECT_URI",
  "AUTHENTIK_POST_LOGOUT_REDIRECT_URI",
  "AUTHENTIK_ALLOWED_GROUPS",
] as const;

describe("OIDC config", () => {
  const savedEnv: Record<string, string | undefined> = {};

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    oidcMocks.discovery.mockClear();
    oidcMocks.allowInsecureRequests.mockClear();
    resetOidcForTests();
    resetAuthConfigForTests();
  });

  it("lets OIDC_* override AUTHENTIK_*", () => {
    const config = resolveAuthConfig({
      ...baseEnv,
      OIDC_ISSUER: "https://idp.example/realms/booth",
      OIDC_CLIENT_ID: "oidc-client",
      OIDC_CLIENT_SECRET: "oidc-secret",
      OIDC_REDIRECT_URI: "https://operator.example/v1/auth/callback",
      OIDC_POST_LOGOUT_REDIRECT_URI: "https://operator.example",
      OIDC_SCOPES: "openid email profile groups",
      OIDC_ALLOWED_GROUPS: "operators,admins",
      OIDC_ALLOWED_EMAILS: "A@EXAMPLE.COM,b@example.com",
    });

    expect(config.disabled).toBe(false);
    if (config.disabled) throw new Error("unexpected disabled config");
    expect(config.issuer).toBe("https://idp.example/realms/booth");
    expect(config.clientId).toBe("oidc-client");
    expect(config.clientSecret).toBe("oidc-secret");
    expect(config.redirectUri).toBe("https://operator.example/v1/auth/callback");
    expect(config.postLogoutRedirectUri).toBe("https://operator.example");
    expect(config.scopes).toBe("openid email profile groups");
    expect(config.allowedGroups).toEqual(["operators", "admins"]);
    expect(config.allowedEmails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("refuses missing required config unless AUTH_DISABLED=true", () => {
    expect(() => resolveAuthConfig({})).toThrow(AuthConfigurationError);
    expect(resolveAuthConfig({ AUTH_DISABLED: "true" })).toEqual({
      disabled: true,
      providerName: "Authentik",
    });
  });

  it("allows HTTP issuer in non-production environments", async () => {
    process.env.NODE_ENV = "test";
    process.env.OIDC_ISSUER = httpEnv.AUTHENTIK_ISSUER;
    process.env.OIDC_CLIENT_ID = httpEnv.AUTHENTIK_CLIENT_ID;
    process.env.OIDC_CLIENT_SECRET = httpEnv.AUTHENTIK_CLIENT_SECRET;
    process.env.OIDC_REDIRECT_URI = httpEnv.AUTHENTIK_REDIRECT_URI;

    const config = resolveAuthConfig(httpEnv);
    expect(config.disabled).toBe(false);
    if (config.disabled) throw new Error("unexpected");
    expect(config.issuer).toBe("http://authentik.example/application/o/booth/");

    await expect(getOidcClient()).resolves.toBeDefined();
    expect(oidcMocks.discovery).toHaveBeenCalledOnce();
    expect(oidcMocks.allowInsecureRequests).toHaveBeenCalledOnce();
  });

  it("rejects an HTTP issuer at startup in production without the escape hatch", () => {
    process.env.NODE_ENV = "production";

    const config = resolveAuthConfig(httpEnv);
    expect(() => assertOidcIssuerAllowed(config)).toThrow(AuthConfigurationError);
  });

  it("allows an HTTP issuer at startup in production with the escape hatch", () => {
    process.env.NODE_ENV = "production";
    process.env.OIDC_ALLOW_HTTP_ISSUER = "true";

    const config = resolveAuthConfig(httpEnv);
    expect(() => assertOidcIssuerAllowed(config)).not.toThrow();
  });

  it("makes getOidcClient reject an HTTP issuer in production without the escape hatch", async () => {
    process.env.NODE_ENV = "production";
    process.env.OIDC_ISSUER = httpEnv.AUTHENTIK_ISSUER;
    process.env.OIDC_CLIENT_ID = httpEnv.AUTHENTIK_CLIENT_ID;
    process.env.OIDC_CLIENT_SECRET = httpEnv.AUTHENTIK_CLIENT_SECRET;
    process.env.OIDC_REDIRECT_URI = httpEnv.AUTHENTIK_REDIRECT_URI;

    await expect(getOidcClient()).rejects.toThrow(AuthConfigurationError);
    expect(oidcMocks.discovery).not.toHaveBeenCalled();
    expect(oidcMocks.allowInsecureRequests).not.toHaveBeenCalled();
  });

  it("rejects production startup when no allow-lists are configured", () => {
    const config = resolveAuthConfig(baseEnv);
    expect(config.disabled).toBe(false);
    if (config.disabled) throw new Error("unexpected");

    // Remove allowed groups to simulate misconfiguration
    const noListConfig = resolveAuthConfig({
      ...baseEnv,
      AUTHENTIK_ALLOWED_GROUPS: "",
    });
    expect(noListConfig.disabled).toBe(false);
    if (noListConfig.disabled) throw new Error("unexpected");

    expect(() =>
      assertAuthorizationConfigured(noListConfig, { NODE_ENV: "production" }),
    ).toThrow(AuthConfigurationError);
  });

  it("allows production startup when allowed groups are configured", () => {
    const config = resolveAuthConfig(baseEnv);
    expect(() =>
      assertAuthorizationConfigured(config, { NODE_ENV: "production" }),
    ).not.toThrow();
  });

  it("allows production startup when only allowed emails are configured", () => {
    const config = resolveAuthConfig({
      ...baseEnv,
      AUTHENTIK_ALLOWED_GROUPS: "",
      OIDC_ALLOWED_EMAILS: "admin@example.com",
    });
    expect(() =>
      assertAuthorizationConfigured(config, { NODE_ENV: "production" }),
    ).not.toThrow();
  });

  it("skips allow-list check in non-production environments", () => {
    const config = resolveAuthConfig({
      ...baseEnv,
      AUTHENTIK_ALLOWED_GROUPS: "",
    });
    expect(() =>
      assertAuthorizationConfigured(config, { NODE_ENV: "test" }),
    ).not.toThrow();
    expect(() =>
      assertAuthorizationConfigured(config, {}),
    ).not.toThrow();
  });
});
