// Mobile bearer-token middleware. Validates Authentik-issued JWT access
// tokens against the provider JWKS, enforces operator group / email
// authorization, and upserts a matching `OperatorUser` row so downstream
// `/v1` handlers can rely on `c.get("user")` exactly like the browser
// cookie-session flow does.
//
// Trust model: tokens MUST
//   • be signed by a key advertised at the provider's `jwks_uri`,
//   • carry `iss === config.issuer`,
//   • carry an `aud` that matches `config.clientId` or any entry in
//     `config.mobileAudiences`,
//   • be unexpired (`exp` claim, with a small allowed clock skew),
//   • pass `validateAuthorization()` (group + email allow-lists).

import type { OperatorUser } from "@prisma/client";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { getRequiredOidcConfig } from "./config.js";
import { getOidcClient } from "./oidc.js";
import type { IDTokenClaims } from "./oidc.js";
import { authorizeAndUpsertOperator } from "./operator-user.js";

const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;
const CLOCK_TOLERANCE_SECONDS = 30;

let cached: { issuer: string; jwks: JWTVerifyGetKey } | null = null;
let jwksFactory: (url: URL) => JWTVerifyGetKey = (url) =>
  createRemoteJWKSet(url, {
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
  });
let jwtVerifyImpl: typeof jwtVerify = jwtVerify;

const loadJwks = async (issuer: string): Promise<JWTVerifyGetKey> => {
  if (cached?.issuer === issuer) return cached.jwks;
  const client = await getOidcClient();
  const jwksUri = client.serverMetadata().jwks_uri;
  if (!jwksUri) {
    throw new Error("OIDC provider metadata is missing jwks_uri; cannot verify bearer tokens.");
  }
  const jwks = jwksFactory(new URL(jwksUri));
  cached = { issuer, jwks };
  return jwks;
};

export type BearerVerifyResult =
  | { ok: true; user: OperatorUser; payload: JWTPayload }
  | { ok: false; status: 401 | 403; reason: string };

const isInvalidTokenError = (error: unknown): boolean =>
  error instanceof joseErrors.JOSEError ||
  (error instanceof Error && /\b(jwt|jws|jwk|jwe)\b/i.test(error.name));

// Verify an `Authorization: Bearer <jwt>` token. Returns 401 for any
// signature / issuer / audience / expiry failure and 403 when the verified
// principal isn't in the operator allow-list.
export const verifyOperatorBearer = async (token: string): Promise<BearerVerifyResult> => {
  const config = getRequiredOidcConfig();

  let payload: JWTPayload;
  try {
    const jwks = await loadJwks(config.issuer);
    const verified = await jwtVerifyImpl(token, jwks, {
      issuer: config.issuer,
      audience: [config.clientId, ...config.mobileAudiences],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
  } catch (error) {
    if (isInvalidTokenError(error)) {
      return { ok: false, status: 401, reason: "invalid_token" };
    }
    throw error;
  }

  const claims = payload as IDTokenClaims;
  const result = await authorizeAndUpsertOperator(claims);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status === 400 ? 401 : 403,
      reason: result.reason,
    };
  }
  return { ok: true, user: result.user, payload };
};

// Test-only escape hatch so specs can inject a fake JWKS + verifier
// without standing up a real Authentik instance.
export const __setBearerVerifierForTests = (overrides: {
  jwks?: (url: URL) => JWTVerifyGetKey;
  jwtVerify?: typeof jwtVerify;
}): void => {
  if (overrides.jwks) jwksFactory = overrides.jwks;
  if (overrides.jwtVerify) jwtVerifyImpl = overrides.jwtVerify;
  cached = null;
};

export const resetBearerAuthForTests = (): void => {
  cached = null;
  jwksFactory = (url) =>
    createRemoteJWKSet(url, {
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });
  jwtVerifyImpl = jwtVerify;
};
