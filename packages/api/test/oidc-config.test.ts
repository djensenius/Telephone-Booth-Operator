import { afterEach, describe, expect, it } from "vite-plus/test";
import { AuthConfigurationError, resolveAuthConfig } from "../src/lib/config.js";

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

describe("OIDC config", () => {
  afterEach(() => {
    delete process.env.AUTH_DISABLED;
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

  it("allows HTTP issuer in non-production environments", () => {
    const config = resolveAuthConfig(httpEnv);
    expect(config.disabled).toBe(false);
    if (config.disabled) throw new Error("unexpected");
    expect(config.issuer).toBe("http://authentik.example/application/o/booth/");
  });

  it("resolves HTTP issuer config regardless of NODE_ENV (startup validates)", () => {
    // resolveAuthConfig itself does not check NODE_ENV — that's done at startup.
    // This ensures the config layer remains environment-agnostic.
    const config = resolveAuthConfig(httpEnv);
    expect(config.disabled).toBe(false);
    if (config.disabled) throw new Error("unexpected");
    expect(config.issuer.startsWith("http:")).toBe(true);
  });
});
