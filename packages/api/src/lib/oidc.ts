import { createHash } from "node:crypto";
import * as oidc from "openid-client";
import type {
  Configuration,
  IDToken as IDTokenClaims,
  TokenEndpointResponse,
  TokenEndpointResponseHelpers,
} from "openid-client";
import {
  assertOidcIssuerAllowed,
  getRequiredOidcConfig,
  isHttpOidcIssuer,
  resetAuthConfigForTests,
} from "./config.js";

export type Client = Configuration;
export type TokenSet = TokenEndpointResponse & TokenEndpointResponseHelpers;
export type { IDTokenClaims };
export type CodeExchangeResult = {
  tokenSet: TokenSet;
  claims: IDTokenClaims;
};

export type ExchangeParams = URL | Request | URLSearchParams | string;

let cachedClient: { key: string; client: Client; loadedAt: number } | null = null;

const cacheKey = (): string => {
  const config = getRequiredOidcConfig();
  return `${config.issuer}\u0000${config.clientId}`;
};

export const getOidcClient = async (): Promise<Client> => {
  const config = getRequiredOidcConfig();
  const key = cacheKey();
  const maxAgeMs = 10 * 60 * 1000;
  if (cachedClient && cachedClient.key === key && Date.now() - cachedClient.loadedAt < maxAgeMs) {
    return cachedClient.client;
  }

  assertOidcIssuerAllowed(config);

  const client = await oidc.discovery(
    new URL(config.issuer),
    config.clientId,
    {
      client_secret: config.clientSecret,
      redirect_uris: [config.redirectUri],
      response_types: ["code"],
    },
    oidc.ClientSecretPost(config.clientSecret),
  );

  if (isHttpOidcIssuer(config)) {
    oidc.allowInsecureRequests(client);
  }

  cachedClient = { key, client, loadedAt: Date.now() };
  return client;
};

const currentClient = (): Client => {
  const key = cacheKey();
  if (!cachedClient || cachedClient.key !== key) {
    throw new Error("OIDC client has not been initialized; call getOidcClient() first.");
  }
  return cachedClient.client;
};

const codeChallenge = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

export const buildAuthorizationUrl = (state: string, nonce: string, codeVerifier: string): URL => {
  const config = getRequiredOidcConfig();
  return oidc.buildAuthorizationUrl(currentClient(), {
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes,
    state,
    nonce,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
  });
};

const callbackUrlForGrant = (params: ExchangeParams): URL => {
  const config = getRequiredOidcConfig();
  const url = new URL(config.redirectUri);
  if (params instanceof Request) {
    url.search = new URL(params.url).search;
  } else if (params instanceof URL) {
    url.search = params.search;
  } else if (typeof params === "string") {
    url.search = new URL(params).search;
  } else {
    url.search = params.toString();
  }
  return url;
};

export const exchangeCode = async (
  params: ExchangeParams,
  codeVerifier: string,
  expectedState: string,
  expectedNonce: string,
): Promise<CodeExchangeResult> => {
  const tokens = await oidc.authorizationCodeGrant(
    await getOidcClient(),
    callbackUrlForGrant(params),
    {
      expectedNonce,
      expectedState,
      idTokenExpected: true,
      pkceCodeVerifier: codeVerifier,
    },
  );
  const claims = tokens.claims();
  if (!claims) {
    throw new Error("OIDC provider did not return an ID token.");
  }
  return { tokenSet: tokens, claims };
};

// Thrown by `refreshTokens`. `rejected` distinguishes a refresh token the IdP
// will never accept again (expired, rotated away, or revoked — an OAuth error
// response in the 4xx range) from a transient failure (provider 5xx, network
// fault) where the token is still good and the caller should keep the session
// and retry rather than forcing a fresh login.
export class TokenRefreshError extends Error {
  override name = "TokenRefreshError";
  readonly rejected: boolean;
  constructor(message: string, rejected: boolean) {
    super(message);
    this.rejected = rejected;
  }
}

export const refreshTokens = async (refreshToken: string): Promise<TokenSet> => {
  try {
    return await oidc.refreshTokenGrant(await getOidcClient(), refreshToken);
  } catch (error) {
    // A 4xx OAuth error body (typically `invalid_grant`) is the provider
    // definitively refusing this refresh token. Anything else — provider 5xx,
    // DNS/TLS/network faults, malformed responses — may succeed on retry.
    const rejected =
      error instanceof oidc.WWWAuthenticateChallengeError ||
      (error instanceof oidc.ResponseBodyError && error.status >= 400 && error.status < 500);
    throw new TokenRefreshError(
      error instanceof Error ? error.message : "token refresh request failed",
      rejected,
    );
  }
};

// Thrown by `fetchOperatorUserInfo`. `rejected` distinguishes an active
// rejection by the IdP (the userinfo endpoint returned 401/403 — i.e. the
// account was deleted or the token revoked) from a transient failure
// (network error, IdP outage) where callers should fail open and retry.
export class UserRevalidationError extends Error {
  override name = "UserRevalidationError";
  readonly rejected: boolean;
  constructor(message: string, rejected: boolean) {
    super(message);
    this.rejected = rejected;
  }
}

// Call the provider's userinfo endpoint with a live access token to confirm the
// account still exists and to pick up its current claims (groups, email). This
// hits the IdP directly, so a deleted user is detected even while their
// self-contained access token is still cryptographically unexpired.
export const fetchOperatorUserInfo = async (
  accessToken: string,
  expectedSubject: string,
): Promise<IDTokenClaims> => {
  try {
    const info = await oidc.fetchUserInfo(await getOidcClient(), accessToken, expectedSubject);
    return info as unknown as IDTokenClaims;
  } catch (error) {
    // Only an *authorization* failure means the account was deleted or the
    // token revoked: a WWW-Authenticate challenge (401) or a userinfo error
    // response with a 401/403 status. Any other error — including provider
    // 5xx responses (also surfaced as `ResponseBodyError`) and network faults
    // — is transient, so callers should fail open and retry rather than
    // signing valid operators out during an IdP outage.
    const rejected =
      error instanceof oidc.WWWAuthenticateChallengeError ||
      (error instanceof oidc.ResponseBodyError && (error.status === 401 || error.status === 403));
    throw new UserRevalidationError(
      error instanceof Error ? error.message : "userinfo request failed",
      rejected,
    );
  }
};

export const endSessionUrl = (idTokenHint: string | null | undefined): URL | null => {
  const config = getRequiredOidcConfig();
  const client = currentClient();
  if (!client.serverMetadata().end_session_endpoint) return null;

  const parameters: Record<string, string> = {};
  if (idTokenHint) parameters.id_token_hint = idTokenHint;
  if (config.postLogoutRedirectUri) {
    parameters.post_logout_redirect_uri = config.postLogoutRedirectUri;
  }
  return oidc.buildEndSessionUrl(client, parameters);
};

export const resetOidcForTests = (): void => {
  cachedClient = null;
  resetAuthConfigForTests();
};
