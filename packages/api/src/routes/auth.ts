import { randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zValidator } from "@hono/zod-validator";
import { OperatorMeSchema } from "@telephone-booth-operator/shared";
import { z } from "zod";
import { getAuthConfig } from "../lib/config.js";
import { auditEnabled, recordAudit, writeAuditEntry, type AuditActorType } from "../lib/audit.js";
import { clientIp } from "../lib/client-ip.js";
import { verifyOperatorBearer } from "../lib/bearer-auth.js";
import { buildAuthorizationUrl, endSessionUrl, exchangeCode, getOidcClient } from "../lib/oidc.js";
import {
  authorizeAndUpsertOperator,
  groupsFromClaims as _groupsFromClaims,
  validateAuthorization as _validateAuthorization,
} from "../lib/operator-user.js";
import {
  createSession,
  decryptSessionSecret,
  destroySession,
  readValidSession,
  setSessionCookie,
  signedCookieValue,
  verifyCookieValue,
  cookieValueFromHeader,
  type AuthVariables,
} from "../lib/session.js";

// Re-exported for tests + downstream code that imported them from this
// module before the shared `operator-user.ts` extraction.
export const groupsFromClaims = _groupsFromClaims;
export const validateAuthorization = _validateAuthorization;

const loginQuerySchema = z.object({
  return_to: z.string().optional(),
});

// Best-effort identity for a login attempt that never produced an operator
// row. Claims are provider-supplied JSON, so narrow before use.
const claimLabel = (claims: { email?: unknown; sub?: unknown }): string => {
  if (typeof claims.email === "string" && claims.email) return claims.email;
  if (typeof claims.sub === "string" && claims.sub) return claims.sub;
  return "unknown";
};

// The OIDC callback is a GET, so `auditWrites()` (which only wraps mutating
// methods) never sees it — yet establishing or denying a session is exactly
// the kind of action the trail must contain. Record it by hand.
const auditAuthEvent = async (
  c: Context,
  entry: {
    action: string;
    statusCode: number;
    actorType?: AuditActorType;
    actorUserId?: string | null;
    actorLabel: string;
    targetType?: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> => {
  if (!auditEnabled()) return;
  await writeAuditEntry({
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    actorType: entry.actorType ?? "anonymous",
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    method: c.req.method.toUpperCase(),
    path: new URL(c.req.url).pathname,
    statusCode: entry.statusCode,
    metadata: entry.metadata ?? null,
  });
};

// Every way a callback can fail is still a sign-in attempt, and an attacker
// probing the endpoint is exactly what the trail should show. `reason` is a
// fixed classification, never provider text.
const auditLoginFailed = async (c: Context, reason: string): Promise<void> => {
  await auditAuthEvent(c, {
    action: "auth.login.failed",
    statusCode: 400,
    actorLabel: "unknown",
    metadata: { reason },
  });
};

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

type PendingLogin = {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: number;
};

const pendingLogins = new Map<string, PendingLogin>();
const pendingLoginTtlMs = 5 * 60 * 1000;

const prunePendingLogins = (): void => {
  const oldest = Date.now() - pendingLoginTtlMs;
  for (const [state, login] of pendingLogins) {
    if (login.createdAt < oldest) pendingLogins.delete(state);
  }
};

const LOGIN_TX_COOKIE_NAME = "__Host-booth_login_tx";
const DEV_LOGIN_TX_COOKIE_NAME = "booth_login_tx";

const safeReturnTo = (input: string | undefined): string => {
  if (!input) return "/";
  if (!input.startsWith("/") || input.startsWith("//")) return "/";

  try {
    const parsed = new URL(input, "http://operator.local");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
};

const webRedirectBase = (): URL => {
  const raw =
    (process.env.WEB_ORIGIN ?? process.env.PUBLIC_WEB_URL ?? "http://localhost:5173")
      .split(",")[0]
      ?.trim() || "http://localhost:5173";
  return new URL(raw);
};

const webRedirectUrl = (returnTo: string): string =>
  new URL(returnTo, webRedirectBase()).toString();

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const isLocalFromUrl = (url: string): boolean => {
  try {
    return isLocalHostname(new URL(url).hostname);
  } catch {
    return false;
  }
};

const appendCookieHeader = (
  c: { header: (name: string, value: string, options?: { append: boolean }) => void },
  parts: string[],
): void => {
  c.header("Set-Cookie", parts.join("; "), { append: true });
};

const setLoginTxCookie = (
  c: Parameters<typeof appendCookieHeader>[0] & { req: { url: string } },
  state: string,
): void => {
  const signed = encodeURIComponent(signedCookieValue(state));
  const maxAge = String(Math.floor(pendingLoginTtlMs / 1000));
  appendCookieHeader(c, [
    `${LOGIN_TX_COOKIE_NAME}=${signed}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ]);

  if (process.env.NODE_ENV === "production" || !isLocalFromUrl(c.req.url)) return;
  appendCookieHeader(c, [
    `${DEV_LOGIN_TX_COOKIE_NAME}=${signed}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ]);
};

const clearLoginTxCookie = (
  c: Parameters<typeof appendCookieHeader>[0] & { req: { url: string } },
): void => {
  appendCookieHeader(c, [
    `${LOGIN_TX_COOKIE_NAME}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ]);

  if (process.env.NODE_ENV === "production" || !isLocalFromUrl(c.req.url)) return;
  appendCookieHeader(c, [
    `${DEV_LOGIN_TX_COOKIE_NAME}=`,
    "Path=/",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ]);
};

const readLoginTxCookie = (cookieHeader: string | undefined): string | null => {
  const raw =
    cookieValueFromHeader(cookieHeader, LOGIN_TX_COOKIE_NAME) ??
    (process.env.NODE_ENV !== "production"
      ? cookieValueFromHeader(cookieHeader, DEV_LOGIN_TX_COOKIE_NAME)
      : undefined);
  return verifyCookieValue(raw);
};

export const escapeHtml = (unsafe: string): string =>
  unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const htmlBody = (title: string, detail: string): string => {
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${safeTitle}</title></head>
  <body><h1>${safeTitle}</h1><p>${safeDetail}</p></body>
</html>`;
};

const htmlResponse = (
  c: {
    html: (
      body: string,
      status?: ContentfulStatusCode,
      headers?: Record<string, string>,
    ) => Response | Promise<Response>;
  },
  title: string,
  detail: string,
  status: ContentfulStatusCode,
): Response | Promise<Response> =>
  c.html(htmlBody(title, detail), status, {
    "Content-Security-Policy": "default-src 'none'",
  });

const logAuthCallbackError = (error: unknown): void => {
  const payload =
    error instanceof Error
      ? {
          level: "error",
          event: "auth_callback_failed",
          error: error.name,
          message: error.message,
        }
      : {
          level: "error",
          event: "auth_callback_failed",
          error: "UnknownError",
        };
  console.error(JSON.stringify(payload));
};

const operatorMeFromUser = (user: {
  oidcSub: string;
  email: string;
  name: string;
  groups: unknown;
  isAdmin: boolean;
  picture: string | null;
}) => {
  const groups = Array.isArray(user.groups)
    ? user.groups.filter((group): group is string => typeof group === "string")
    : [];
  const payload = {
    id: user.oidcSub,
    email: user.email,
    name: user.name,
    groups,
    isAdmin: user.isAdmin,
    providerName: getAuthConfig().providerName,
    ...(user.picture ? { picture: user.picture } : {}),
  };
  return OperatorMeSchema.parse(payload);
};

const operatorMe = (session: Awaited<ReturnType<typeof readValidSession>>) => {
  if (!session) return null;
  return operatorMeFromUser(session.user);
};

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

authRoutes.get("/login", zValidator("query", loginQuerySchema), async (c) => {
  if (getAuthConfig().disabled) {
    return htmlResponse(
      c,
      "Authentication disabled",
      "AUTH_DISABLED=true is enabled for local development.",
      503,
    );
  }

  prunePendingLogins();
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  pendingLogins.set(state, {
    nonce,
    codeVerifier,
    returnTo: safeReturnTo(c.req.valid("query").return_to),
    createdAt: Date.now(),
  });

  await getOidcClient();
  setLoginTxCookie(c, state);
  return c.redirect(buildAuthorizationUrl(state, nonce, codeVerifier).toString(), 302);
});

authRoutes.get("/callback", zValidator("query", callbackQuerySchema), async (c) => {
  const query = c.req.valid("query");
  if (query.error) {
    clearLoginTxCookie(c);
    await auditLoginFailed(c, "provider_error");
    return htmlResponse(c, "OIDC login failed", query.error_description ?? query.error, 400);
  }
  if (!query.code || !query.state) {
    clearLoginTxCookie(c);
    await auditLoginFailed(c, "missing_code_or_state");
    return htmlResponse(c, "OIDC login failed", "Missing code or state.", 400);
  }

  // Verify the login transaction cookie binds this callback to the browser
  // that initiated the login request (prevents login-CSRF / session-fixation).
  const txState = readLoginTxCookie(c.req.header("cookie"));
  clearLoginTxCookie(c);
  if (!txState || txState !== query.state) {
    await auditLoginFailed(c, "login_tx_mismatch");
    return htmlResponse(
      c,
      "OIDC login failed",
      "Login transaction cookie missing or mismatched.",
      400,
    );
  }

  prunePendingLogins();
  const pending = pendingLogins.get(query.state);
  pendingLogins.delete(query.state);
  if (!pending) {
    await auditLoginFailed(c, "login_state_expired");
    return htmlResponse(c, "OIDC login failed", "Login state expired or was not recognized.", 400);
  }

  try {
    const { tokenSet, claims } = await exchangeCode(
      new URL(c.req.url),
      pending.codeVerifier,
      query.state,
      pending.nonce,
    );

    const result = await authorizeAndUpsertOperator(claims, { markLogin: true });
    if (!result.ok) {
      if (result.status === 403) {
        await auditAuthEvent(c, {
          action: "auth.login.denied",
          statusCode: 403,
          actorLabel: claimLabel(claims),
          metadata: { reason: result.reason },
        });
        return htmlResponse(c, "Operator credentials required", result.reason, 403);
      }
      await auditAuthEvent(c, {
        action: "auth.login.failed",
        statusCode: 400,
        actorLabel: claimLabel(claims),
        metadata: { reason: result.reason },
      });
      return htmlResponse(
        c,
        "OIDC login failed",
        result.reason === "missing_email_claim"
          ? "The provider did not return an email claim."
          : "The login response could not be validated.",
        400,
      );
    }

    const session = await createSession(result.user, tokenSet, c);
    setSessionCookie(c, session.id, session.expiresAt);
    // Login creates a session — a write action in its own right. The callback
    // is a GET, so it is recorded explicitly rather than by `auditWrites()`.
    await auditAuthEvent(c, {
      action: "auth.login",
      statusCode: 302,
      actorType: "operator",
      actorUserId: result.user.id,
      actorLabel: result.user.email,
      targetType: "session",
      targetId: session.id,
    });
    return c.redirect(webRedirectUrl(pending.returnTo), 302);
  } catch (error) {
    logAuthCallbackError(error);
    await auditLoginFailed(c, "code_exchange_failed");
    return htmlResponse(c, "OIDC login failed", "The login response could not be validated.", 400);
  }
});

authRoutes.post("/logout", async (c) => {
  const session = await destroySession(c);
  recordAudit(c, {
    action: "auth.logout",
    targetType: "session",
    targetId: session?.id ?? null,
    ...(session
      ? {
          actorType: "operator" as const,
          actorUserId: session.userId,
          actorLabel: session.user.email,
        }
      : {}),
  });
  let redirectTo = webRedirectUrl("/login");
  const idToken = decryptSessionSecret(session?.idToken);
  if (idToken && !getAuthConfig().disabled) {
    await getOidcClient();
    redirectTo = endSessionUrl(idToken)?.toString() ?? redirectTo;
  }
  return c.redirect(redirectTo, 302);
});

authRoutes.get("/me", async (c) => {
  // Auth routes are mounted BEFORE `requireOperator()` in `index.ts`, so
  // the middleware never runs here. Support both session-cookie and
  // bearer-token clients explicitly.
  const authorization = c.req.header("authorization");
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  if (match && match[1]) {
    const result = await verifyOperatorBearer(match[1].trim());
    if (!result.ok) {
      return c.json({ error: result.reason }, result.status);
    }
    return c.json(operatorMeFromUser(result.user));
  }
  const session = await readValidSession(c);
  const me = operatorMe(session);
  if (!me) {
    return c.json({ error: "unauthenticated", login_url: "/v1/auth/login" }, 401);
  }
  return c.json(me);
});

export const resetAuthRouteStateForTests = (): void => {
  pendingLogins.clear();
};
