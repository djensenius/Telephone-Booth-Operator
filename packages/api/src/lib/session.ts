import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { OperatorSession, OperatorUser } from "@prisma/client";
import type { Context, MiddlewareHandler } from "hono";
import { verifyOperatorBearer } from "./bearer-auth.js";
import { getAuthConfig } from "./config.js";
import { db } from "./db.js";
import {
  fetchOperatorUserInfo,
  refreshTokens,
  UserRevalidationError,
  type TokenSet,
} from "./oidc.js";
import { revalidateOperatorFromClaims } from "./operator-user.js";
import { requireApiToken, type ApiTokenVariables } from "./require-api-token.js";

export const SESSION_COOKIE_NAME = "__Host-booth_session";
const DEV_SESSION_COOKIE_NAME = "booth_session";

type SessionUser = OperatorSession & { user: OperatorUser };

export type AuthVariables = {
  user: OperatorUser;
  session: SessionUser | null;
};

type TokenInput = Partial<TokenSet> & {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expiresIn?: () => number | undefined;
};

let generatedCookieSecret: string | null = null;
let warnedCookieSecret = false;
let generatedEncryptionKey: Buffer | null = null;
let warnedEncryptionKey = false;
let cachedEncryptionKey: { raw: string; key: Buffer } | null = null;
const pendingRefreshes = new Map<string, Promise<SessionUser | null>>();

const warn = (message: string): void => {
  if (process.env.NODE_ENV !== "test") {
    console.warn(message);
  }
};

const getSessionSecret = (): string => {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }
  generatedCookieSecret ??= randomBytes(32).toString("base64url");
  if (!warnedCookieSecret) {
    warnedCookieSecret = true;
    warn("SESSION_SECRET missing; generated a dev-only in-memory cookie signing secret.");
  }
  return generatedCookieSecret;
};

const decodeEncryptionKey = (raw: string): Buffer => {
  const base64 = Buffer.from(raw, "base64");
  if (base64.length === 32) return base64;

  const hex = Buffer.from(raw, "hex");
  if (hex.length === 32) return hex;

  throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 preferred).");
};

const getEncryptionKey = (): Buffer => {
  const configured = process.env.SESSION_ENCRYPTION_KEY?.trim();
  if (configured) {
    if (cachedEncryptionKey?.raw === configured) return cachedEncryptionKey.key;
    const key = decodeEncryptionKey(configured);
    cachedEncryptionKey = { raw: configured, key };
    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_ENCRYPTION_KEY is required in production.");
  }

  generatedEncryptionKey ??= randomBytes(32);
  if (!warnedEncryptionKey) {
    warnedEncryptionKey = true;
    warn("SESSION_ENCRYPTION_KEY missing; generated a dev-only in-memory encryption key.");
  }
  return generatedEncryptionKey;
};

const signValue = (payload: string): string =>
  createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");

export const signedCookieValue = (payload: string): string => `${payload}.${signValue(payload)}`;

export const verifyCookieValue = (value: string | undefined): string | null => {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signValue(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  return timingSafeEqual(signatureBuffer, expectedBuffer) ? payload : null;
};

export const cookieValueFromHeader = (
  cookieHeader: string | undefined,
  name: string,
): string | undefined => {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    return decodeURIComponent(trimmed.slice(separator + 1));
  }
  return undefined;
};

const devCookieEnabled = (): boolean => process.env.NODE_ENV !== "production";

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const isLocalRequest = (c: Context): boolean => {
  const url = new URL(c.req.url);
  const host = c.req.header("host") ?? url.host;
  const hostname = host.split(":")[0] ?? host;
  return isLocalHostname(hostname);
};

export const encryptSessionSecret = (plaintext: string | null | undefined): string | null => {
  if (!plaintext) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
};

export const decryptSessionSecret = (encrypted: string | null | undefined): string | null => {
  if (!encrypted) return null;
  const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
    // Legacy plaintext value stored before encryption was applied to this field.
    return encrypted;
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

const csv = (input: string | undefined): string[] =>
  (input ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const trustsForwardedHeaders = (): boolean => csv(process.env.TRUSTED_PROXIES).length > 0;

const forwardedFirst = (headers: Headers, name: string): string | null => {
  if (!trustsForwardedHeaders()) return null;
  return headers.get(name)?.split(",")[0]?.trim() ?? null;
};

const requestIp = (request: Request): string | null =>
  forwardedFirst(request.headers, "x-forwarded-for");

const appendCookie = (c: Context, parts: string[]): void => {
  c.header("Set-Cookie", parts.join("; "), { append: true });
};

export const setSessionCookie = (c: Context, sessionId: string, expiresAt: Date): void => {
  const signedValue = encodeURIComponent(signedCookieValue(sessionId));
  const parts = [
    `${SESSION_COOKIE_NAME}=${signedValue}`,
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ];
  appendCookie(c, parts);

  if (!devCookieEnabled() || !isLocalRequest(c)) return;
  appendCookie(c, [
    `${DEV_SESSION_COOKIE_NAME}=${signedValue}`,
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
  ]);
};

export const clearSessionCookie = (c: Context): void => {
  appendCookie(c, [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ]);

  if (!devCookieEnabled() || !isLocalRequest(c)) return;
  appendCookie(c, [
    `${DEV_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ]);
};

const ttlSecondsFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sessionExpiresAt = (): Date =>
  new Date(Date.now() + Math.max(ttlSecondsFromEnv("SESSION_TTL_SECONDS", 43_200), 300) * 1000);

const accessTokenExpiresAt = (tokens: TokenInput): Date | null => {
  const ttlSeconds = tokens.expires_in ?? tokens.expiresIn?.();
  if (ttlSeconds === undefined) return null;
  return new Date(Date.now() + Math.max(ttlSeconds, 60) * 1000);
};

export const createSession = async (
  user: OperatorUser,
  tokens: TokenInput,
  request: Request,
): Promise<OperatorSession> => {
  const id = randomBytes(32).toString("base64url");
  return db.operatorSession.create({
    data: {
      id,
      userId: user.id,
      idToken: encryptSessionSecret(tokens.id_token),
      accessToken: encryptSessionSecret(tokens.access_token),
      refreshToken: encryptSessionSecret(tokens.refresh_token),
      accessTokenExpiresAt: accessTokenExpiresAt(tokens),
      expiresAt: sessionExpiresAt(),
      lastValidatedAt: new Date(),
      ip: requestIp(request),
      userAgent: request.headers.get("user-agent"),
    },
  });
};

export const readSessionFromCookieHeader = async (
  cookieHeader: string | undefined,
): Promise<SessionUser | null> => {
  const cookieValue =
    cookieValueFromHeader(cookieHeader, SESSION_COOKIE_NAME) ??
    (devCookieEnabled() ? cookieValueFromHeader(cookieHeader, DEV_SESSION_COOKIE_NAME) : undefined);
  const sessionId = verifyCookieValue(cookieValue);
  if (!sessionId) return null;

  const session = await db.operatorSession.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;

  await db.operatorSession.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  return session;
};

export const readSession = async (c: Context): Promise<SessionUser | null> =>
  readSessionFromCookieHeader(c.req.header("cookie"));

export const sessionIsExpired = (session: Pick<OperatorSession, "expiresAt">): boolean =>
  session.expiresAt.getTime() <= Date.now();

export const destroySession = async (c: Context): Promise<SessionUser | null> => {
  const session = await readSession(c);
  clearSessionCookie(c);
  if (session) {
    await db.operatorSession.delete({ where: { id: session.id } }).catch(() => undefined);
  }
  return session;
};

const unauthorized = (c: Context) =>
  c.json({ error: "unauthenticated", login_url: "/v1/auth/login" }, 401);

const logRefreshFailure = (error: unknown): void => {
  const payload =
    error instanceof Error
      ? {
          level: "warn",
          event: "auth_refresh_failed",
          error: error.name,
          message: error.message,
        }
      : {
          level: "warn",
          event: "auth_refresh_failed",
          error: "UnknownError",
        };
  console.error(JSON.stringify(payload));
};

const refreshAccessToken = async (
  session: SessionUser,
  refreshToken: string,
): Promise<SessionUser | null> => {
  try {
    const tokens = await refreshTokens(refreshToken);
    return await db.operatorSession.update({
      where: { id: session.id },
      data: {
        accessToken: encryptSessionSecret(tokens.access_token) ?? session.accessToken,
        idToken: encryptSessionSecret(tokens.id_token) ?? session.idToken,
        refreshToken: encryptSessionSecret(tokens.refresh_token ?? refreshToken),
        accessTokenExpiresAt: accessTokenExpiresAt(tokens),
        lastSeenAt: new Date(),
      },
      include: { user: true },
    });
  } catch (error) {
    logRefreshFailure(error);
    const current = await db.operatorSession.findUnique({
      where: { id: session.id },
      include: { user: true },
    });
    if (
      current &&
      !sessionIsExpired(current) &&
      (!current.accessTokenExpiresAt ||
        current.accessTokenExpiresAt.getTime() > Date.now() + 60_000)
    ) {
      return current;
    }
    return null;
  }
};

const refreshIfAccessTokenExpired = async (
  c: Context,
  session: SessionUser,
): Promise<SessionUser | null> => {
  if (
    !session.accessTokenExpiresAt ||
    session.accessTokenExpiresAt.getTime() > Date.now() + 60_000
  ) {
    return session;
  }

  const refreshToken = decryptSessionSecret(session.refreshToken);
  if (!refreshToken) {
    await destroySession(c);
    return null;
  }

  const refresh =
    pendingRefreshes.get(session.id) ??
    refreshAccessToken(session, refreshToken).finally(() => pendingRefreshes.delete(session.id));
  pendingRefreshes.set(session.id, refresh);

  const updated = await refresh;
  if (updated) {
    setSessionCookie(c, updated.id, updated.expiresAt);
    return updated;
  }

  await destroySession(c);
  return null;
};

const logRevalidationOutcome = (
  event: "auth_revalidation_rejected" | "auth_revalidation_transient" | "auth_revalidation_revoked",
  session: SessionUser,
  error?: unknown,
): void => {
  const base = {
    level: event === "auth_revalidation_transient" ? "warn" : "info",
    event,
    sub: session.user.oidcSub,
  };
  const payload =
    error instanceof Error ? { ...base, error: error.name, message: error.message } : base;
  console.error(JSON.stringify(payload));
};

const revalidateIntervalMs = (): number =>
  Math.max(ttlSecondsFromEnv("SESSION_REVALIDATE_SECONDS", 300), 60) * 1000;

// True only when OIDC is configured and enabled. Reading the config throws when
// OIDC is unconfigured (e.g. AUTH_DISABLED local dev, or unit tests that mock
// sessions directly); in those cases we cannot — and should not — revalidate.
const oidcRevalidationEnabled = (): boolean => {
  try {
    return !getAuthConfig().disabled;
  } catch {
    return false;
  }
};

const sessionNeedsRevalidation = (session: SessionUser): boolean => {
  const last = session.lastValidatedAt?.getTime();
  if (last === undefined || last === null) return true;
  return Date.now() - last >= revalidateIntervalMs();
};

// Periodically confirm the session's account still exists and is still
// authorized at the IdP. This catches accounts deleted in Authentik (or
// removed from the operator group) that would otherwise remain usable until
// their access token happened to expire — even across the full session TTL.
const revalidateSessionAgainstIdp = async (
  c: Context,
  session: SessionUser,
): Promise<SessionUser | null> => {
  if (!oidcRevalidationEnabled()) return session;
  if (!sessionNeedsRevalidation(session)) return session;

  const accessToken = decryptSessionSecret(session.accessToken);
  if (!accessToken) {
    // No access token to check liveness with (e.g. legacy session). The
    // session TTL and refresh-token checks still bound its lifetime; skip
    // rather than forcing an aggressive logout.
    return session;
  }

  try {
    const claims = await fetchOperatorUserInfo(accessToken, session.user.oidcSub);
    const outcome = await revalidateOperatorFromClaims(claims);
    if (!outcome.ok) {
      logRevalidationOutcome("auth_revalidation_revoked", session);
      await destroySession(c);
      return null;
    }
    const updated = await db.operatorSession.update({
      where: { id: session.id },
      data: { lastValidatedAt: new Date() },
      include: { user: true },
    });
    return updated;
  } catch (error) {
    if (error instanceof UserRevalidationError && error.rejected) {
      // The IdP actively rejected the token: the account was deleted or the
      // token revoked. End the session immediately.
      logRevalidationOutcome("auth_revalidation_rejected", session, error);
      await destroySession(c);
      return null;
    }
    // Transient failure (network / IdP outage): keep the session, but still
    // advance lastValidatedAt so we retry on the normal cadence instead of
    // re-hitting the IdP on every subsequent request for the duration of the
    // outage (the web client fires many concurrent queries).
    logRevalidationOutcome("auth_revalidation_transient", session, error);
    try {
      return await db.operatorSession.update({
        where: { id: session.id },
        data: { lastValidatedAt: new Date() },
        include: { user: true },
      });
    } catch {
      return session;
    }
  }
};

export const readValidSession = async (c: Context): Promise<SessionUser | null> => {
  const session = await readSession(c);
  if (!session) return null;
  if (sessionIsExpired(session)) {
    await destroySession(c);
    return null;
  }
  const refreshed = await refreshIfAccessTokenExpired(c, session);
  if (!refreshed) return null;
  return revalidateSessionAgainstIdp(c, refreshed);
};

const publicV1Route = (path: string, method: string): boolean => {
  if (path.startsWith("/v1/auth/")) return true;
  if (path === "/v1/healthz") return true;
  // `/v1/status` is authenticated per-route: GET accepts an operator session,
  // operator bearer, or phone API token (see `requireOperatorOrApiToken`); PUT is
  // protected by phone API-token middleware. Both bypass the operator-only global
  // guard so the booth (which has no operator cookie) is not rejected here.
  if (method === "GET" && path === "/v1/status") return true;
  if (method === "PUT" && path === "/v1/status") return true;
  // Booth → API observability endpoints use bearer-token auth; the per-route
  // middleware enforces it. They must bypass requireOperator() because the
  // booth has no operator cookie.
  if (method === "POST" && path === "/v1/events") return true;
  if (method === "PUT" && path === "/v1/system") return true;
  if (method === "GET" && path === "/v1/questions/random") return true;
  if (method === "GET" && /^\/v1\/instructions\/current\/?$/.test(path)) return true;
  if (method === "GET" && path === "/v1/messages/random") return true;
  if (method === "POST" && path === "/v1/messages") return true;
  if (method === "POST" && /^\/v1\/messages\/[^/]+\/complete$/.test(path)) return true;
  return false;
};

const bearerToken = (c: Context): string | null => {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
};

export const requireOperator =
  (): MiddlewareHandler<{ Variables: AuthVariables }> => async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (publicV1Route(path, c.req.method)) {
      await next();
      return;
    }

    return authenticateOperator(c, next);
  };

// Operator authentication core shared by `requireOperator` (after the public
// allow-list) and by mixed-auth routes such as `GET /v1/status`. Accepts an
// operator bearer (JWT) or an operator session cookie.
const authenticateOperator: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const token = bearerToken(c);
  if (token) {
    const result = await verifyOperatorBearer(token);
    if (!result.ok) {
      return c.json({ error: result.reason }, result.status);
    }
    c.set("user", result.user);
    c.set("session", null);
    await next();
    return;
  }

  const session = await readValidSession(c);
  if (!session) return unauthorized(c);

  c.set("user", session.user);
  c.set("session", session);
  await next();
};

// Guard for read endpoints consumed by both operator clients and the booth. The
// booth/phone client presents a static API token; operator clients use a session
// cookie or an operator bearer (JWT). Any valid credential is accepted; requests
// with none are rejected with 401. Used by `GET /v1/status` so booth state is no
// longer disclosed to unauthenticated callers.
export const requireOperatorOrApiToken =
  (): MiddlewareHandler<{ Variables: AuthVariables & ApiTokenVariables }> =>
  async (c, next) => {
    let authorizedByApiToken = false;
    const markAuthorized = (): Promise<void> => {
      authorizedByApiToken = true;
      return Promise.resolve();
    };
    await requireApiToken()(
      c as unknown as Context<{ Variables: ApiTokenVariables }, string, Record<string, never>>,
      markAuthorized,
    );
    if (authorizedByApiToken) {
      await next();
      return;
    }

    return authenticateOperator(
      c as unknown as Context<{ Variables: AuthVariables }, string, Record<string, never>>,
      next,
    );
  };

export const requireSession = requireOperator;

// Operator **admin** guard. Mount AFTER `requireOperator()` so `c.get("user")`
// is populated. Returns 403 for authenticated operators who are not admins.
export const requireAdmin =
  (): MiddlewareHandler<{ Variables: AuthVariables }> => async (c, next) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    if (!user.isAdmin) {
      return c.json({ error: "forbidden", detail: "Operator admin privileges required." }, 403);
    }
    await next();
  };

export const resetSessionCryptoForTests = (): void => {
  generatedCookieSecret = null;
  generatedEncryptionKey = null;
  cachedEncryptionKey = null;
  pendingRefreshes.clear();
  warnedCookieSecret = false;
  warnedEncryptionKey = false;
};
