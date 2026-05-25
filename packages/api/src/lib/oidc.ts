import { createHash } from "node:crypto";
import * as oidc from "openid-client";
import type {
  Configuration,
  IDToken as IDTokenClaims,
  TokenEndpointResponse,
  TokenEndpointResponseHelpers,
} from "openid-client";
import { getRequiredOidcConfig, resetAuthConfigForTests } from "./config.js";

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

  if (new URL(config.issuer).protocol === "http:") {
    const isProduction = process.env.NODE_ENV === "production";
    const allowHttp = process.env.OIDC_ALLOW_HTTP_ISSUER === "true";
    if (isProduction && !allowHttp) {
      throw new Error(
        "Refusing to use an HTTP OIDC issuer in production. " +
          "Use an HTTPS issuer or set OIDC_ALLOW_HTTP_ISSUER=true (not recommended).",
      );
    }
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

export const refreshTokens = async (refreshToken: string): Promise<TokenSet> =>
  oidc.refreshTokenGrant(await getOidcClient(), refreshToken);

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
