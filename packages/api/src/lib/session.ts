import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OperatorSession, OperatorUser } from "@prisma/client";
import type { Context, MiddlewareHandler } from "hono";
import { verifyOperatorBearer } from "./bearer-auth.js";
import { db } from "./db.js";
import { refreshTokens, type TokenSet } from "./oidc.js";

export const SESSION_COOKIE_NAME = "__Host-booth_session";

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
};

let generatedCookieSecret: string | null = null;
let warnedCookieSecret = false;
let generatedEncryptionKey: Buffer | null = null;
let warnedEncryptionKey = false;
let cachedEncryptionKey: { raw: string; key: Buffer } | null = null;

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

const signSessionId = (sessionId: string): string =>
  createHmac("sha256", getSessionSecret()).update(sessionId).digest("base64url");

const signedCookieValue = (sessionId: string): string => `${sessionId}.${signSessionId(sessionId)}`;

const verifyCookieValue = (value: string | undefined): string | null => {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;

  const sessionId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signSessionId(sessionId);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  return timingSafeEqual(signatureBuffer, expectedBuffer) ? sessionId : null;
};

const cookieValueFromHeader = (cookieHeader: string | undefined, name: string): string | undefined => {
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
    throw new Error("Invalid encrypted session secret format.");
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

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const secureCookie = (c: Context): boolean => {
  const url = new URL(c.req.url);
  const host = c.req.header("host") ?? url.host;
  const hostname = host.split(":")[0] ?? host;
  return !isLocalHostname(hostname);
};

const appendCookie = (c: Context, parts: string[]): void => {
  c.header("Set-Cookie", parts.join("; "), { append: true });
};

export const setSessionCookie = (c: Context, sessionId: string, expiresAt: Date): void => {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedCookieValue(sessionId))}`,
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secureCookie(c)) parts.push("Secure");
  appendCookie(c, parts);
};

export const clearSessionCookie = (c: Context): void => {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secureCookie(c)) parts.push("Secure");
  appendCookie(c, parts);
};

const tokenExpiresAt = (tokens: TokenInput): Date => {
  const ttlSeconds = tokens.expires_in ?? Number.parseInt(process.env.SESSION_TTL_SECONDS ?? "43200", 10);
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
      idToken: tokens.id_token ?? null,
      accessToken: tokens.access_token ?? null,
      refreshToken: encryptSessionSecret(tokens.refresh_token),
      expiresAt: tokenExpiresAt(tokens),
      ip: requestIp(request),
      userAgent: request.headers.get("user-agent"),
    },
  });
};

export const readSessionFromCookieHeader = async (
  cookieHeader: string | undefined,
): Promise<SessionUser | null> => {
  const sessionId = verifyCookieValue(cookieValueFromHeader(cookieHeader, SESSION_COOKIE_NAME));
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

const refreshIfExpired = async (c: Context, session: SessionUser): Promise<SessionUser | null> => {
  if (session.expiresAt.getTime() > Date.now() + 60_000) return session;

  const refreshToken = decryptSessionSecret(session.refreshToken);
  if (!refreshToken) {
    await destroySession(c);
    return null;
  }

  try {
    const tokens = await refreshTokens(refreshToken);
    const updated = await db.operatorSession.update({
      where: { id: session.id },
      data: {
        accessToken: tokens.access_token ?? session.accessToken,
        idToken: tokens.id_token ?? session.idToken,
        refreshToken: encryptSessionSecret(tokens.refresh_token ?? refreshToken),
        expiresAt: tokenExpiresAt(tokens),
        lastSeenAt: new Date(),
      },
      include: { user: true },
    });
    setSessionCookie(c, updated.id, updated.expiresAt);
    return updated;
  } catch {
    await destroySession(c);
    return null;
  }
};

const publicV1Route = (path: string, method: string): boolean => {
  if (path.startsWith("/v1/auth/")) return true;
  if (path === "/v1/healthz") return true;
  // `/v1/status` GET remains public for read-only realtime state for now; PUT is protected by phone API-token middleware.
  if (method === "GET" && path === "/v1/status") return true;
  if (method === "PUT" && path === "/v1/status") return true;
  // Booth → API observability endpoints use bearer-token auth; the per-route
  // middleware enforces it. They must bypass requireOperator() because the
  // booth has no operator cookie.
  if (method === "POST" && path === "/v1/events") return true;
  if (method === "PUT" && path === "/v1/system") return true;
  if (method === "GET" && path === "/v1/questions/random") return true;
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

export const requireOperator = (): MiddlewareHandler<{ Variables: AuthVariables }> =>
  async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (publicV1Route(path, c.req.method)) {
      await next();
      return;
    }

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

    const session = await readSession(c);
    if (!session) return unauthorized(c);

    const refreshed = await refreshIfExpired(c, session);
    if (!refreshed) return unauthorized(c);

    c.set("user", refreshed.user);
    c.set("session", refreshed);
    await next();
  };

export const requireSession = requireOperator;

export const resetSessionCryptoForTests = (): void => {
  generatedCookieSecret = null;
  generatedEncryptionKey = null;
  cachedEncryptionKey = null;
  warnedCookieSecret = false;
  warnedEncryptionKey = false;
};
