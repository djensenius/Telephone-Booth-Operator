export class AuthConfigurationError extends Error {
  override name = "AuthConfigurationError";
}

export type OidcRuntimeConfig = {
  disabled: false;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string | null;
  scopes: string;
  allowedGroups: string[];
  allowedEmails: string[];
  // Additional `aud` values accepted on bearer access tokens — typically the
  // Authentik client_id(s) of native/mobile applications that PKCE-auth
  // against the same provider. The primary `clientId` above is always
  // accepted in addition to this list.
  mobileAudiences: string[];
};

export type AuthDisabledConfig = {
  disabled: true;
  providerName: string;
};

export type AuthConfig = OidcRuntimeConfig | AuthDisabledConfig;

const DEFAULT_SCOPES = "openid email profile offline_access";
const AUTH_DOC = "docs/authentik-setup.md";

const value = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed ? trimmed : undefined;
};

const first = (...inputs: Array<string | undefined>): string | undefined => {
  for (const input of inputs) {
    const trimmed = value(input);
    if (trimmed) return trimmed;
  }
  return undefined;
};

const csv = (input: string | undefined): string[] =>
  (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

export const resolveAuthConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig => {
  const providerName = first(env.OIDC_PROVIDER_NAME, env.AUTHENTIK_PROVIDER_NAME) ?? "Authentik";

  if (env.AUTH_DISABLED === "true") {
    return { disabled: true, providerName };
  }

  const issuer = first(env.OIDC_ISSUER, env.AUTHENTIK_ISSUER);
  const clientId = first(env.OIDC_CLIENT_ID, env.AUTHENTIK_CLIENT_ID);
  const clientSecret = first(env.OIDC_CLIENT_SECRET, env.AUTHENTIK_CLIENT_SECRET);
  const redirectUri = first(env.OIDC_REDIRECT_URI, env.AUTHENTIK_REDIRECT_URI);

  const missing = [
    ["OIDC_ISSUER or AUTHENTIK_ISSUER", issuer],
    ["OIDC_CLIENT_ID or AUTHENTIK_CLIENT_ID", clientId],
    ["OIDC_CLIENT_SECRET or AUTHENTIK_CLIENT_SECRET", clientSecret],
    ["OIDC_REDIRECT_URI or AUTHENTIK_REDIRECT_URI", redirectUri],
  ]
    .filter(([, configured]) => !configured)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new AuthConfigurationError(
      `OIDC authentication is not configured. Missing ${missing.join(", ")}. See ${AUTH_DOC} or set AUTH_DISABLED=true for local development only.`,
    );
  }

  const allowedGroups = csv(
    first(
      env.OIDC_ALLOWED_GROUPS,
      env.AUTHENTIK_ALLOWED_GROUPS,
      env.OIDC_REQUIRED_GROUP,
      env.AUTHENTIK_REQUIRED_GROUP,
    ),
  );

  return {
    disabled: false,
    providerName,
    issuer: issuer!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    postLogoutRedirectUri:
      first(
        env.OIDC_POST_LOGOUT_REDIRECT_URI,
        env.AUTHENTIK_POST_LOGOUT_REDIRECT_URI,
      ) ?? null,
    scopes:
      first(env.OIDC_SCOPES, env.AUTHENTIK_SCOPES) ?? DEFAULT_SCOPES,
    allowedGroups,
    allowedEmails: csv(first(env.OIDC_ALLOWED_EMAILS, env.AUTHENTIK_ALLOWED_EMAILS)).map(
      (email) => email.toLowerCase(),
    ),
    mobileAudiences: csv(
      first(
        env.OIDC_MOBILE_AUDIENCES,
        env.OIDC_MOBILE_CLIENT_IDS,
        env.AUTHENTIK_MOBILE_AUDIENCES,
        env.AUTHENTIK_MOBILE_CLIENT_IDS,
      ),
    ),
  };
};

let cachedConfig: AuthConfig | null = null;

export const getAuthConfig = (): AuthConfig => {
  cachedConfig ??= resolveAuthConfig();
  return cachedConfig;
};

export const getRequiredOidcConfig = (): OidcRuntimeConfig => {
  const config = getAuthConfig();
  if (config.disabled) {
    throw new AuthConfigurationError(
      "OIDC authentication is disabled with AUTH_DISABLED=true; this is intended for local development only.",
    );
  }
  return config;
};

export const resetAuthConfigForTests = (): void => {
  cachedConfig = null;
};
