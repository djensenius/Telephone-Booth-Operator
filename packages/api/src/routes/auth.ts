import { randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OperatorMeSchema } from "@telephone-booth-operator/shared";
import { z } from "zod";
import { getAuthConfig } from "../lib/config.js";
import { verifyOperatorBearer } from "../lib/bearer-auth.js";
import { buildAuthorizationUrl, endSessionUrl, exchangeCode, getOidcClient } from "../lib/oidc.js";
import {
  authorizeAndUpsertOperator,
  groupsFromClaims as _groupsFromClaims,
  validateAuthorization as _validateAuthorization,
} from "../lib/operator-user.js";
import {
  createSession,
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

const appendCookieHeader = (c: { header: (name: string, value: string, options?: { append: boolean }) => void }, parts: string[]): void => {
  c.header("Set-Cookie", parts.join("; "), { append: true });
};

const setLoginTxCookie = (c: Parameters<typeof appendCookieHeader>[0] & { req: { url: string } }, state: string): void => {
  const signed = encodeURIComponent(signedCookieValue(state));
  const maxAge = String(Math.floor(pendingLoginTtlMs / 1000));
  appendCookieHeader(c, [
    `${LOGIN_TX_COOKIE_NAME}=${signed}`,
    "Path=/v1/auth",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ]);

  if (process.env.NODE_ENV === "production" || !isLocalFromUrl(c.req.url)) return;
  appendCookieHeader(c, [
    `${DEV_LOGIN_TX_COOKIE_NAME}=${signed}`,
    "Path=/v1/auth",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ]);
};

const clearLoginTxCookie = (c: Parameters<typeof appendCookieHeader>[0] & { req: { url: string } }): void => {
  appendCookieHeader(c, [
    `${LOGIN_TX_COOKIE_NAME}=`,
    "Path=/v1/auth",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
  ]);

  if (process.env.NODE_ENV === "production" || !isLocalFromUrl(c.req.url)) return;
  appendCookieHeader(c, [
    `${DEV_LOGIN_TX_COOKIE_NAME}=`,
    "Path=/v1/auth",
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
  return verifyCookieValue(raw ? decodeURIComponent(raw) : undefined);
};

const html = (title: string, detail: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p>${detail}</p></body>
</html>`;

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
    return c.html(
      html("Authentication disabled", "AUTH_DISABLED=true is enabled for local development."),
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
    return c.html(html("OIDC login failed", query.error_description ?? query.error), 400);
  }
  if (!query.code || !query.state) {
    clearLoginTxCookie(c);
    return c.html(html("OIDC login failed", "Missing code or state."), 400);
  }

  // Verify the login transaction cookie binds this callback to the browser
  // that initiated the login request (prevents login-CSRF / session-fixation).
  const txState = readLoginTxCookie(c.req.header("cookie"));
  clearLoginTxCookie(c);
  if (!txState || txState !== query.state) {
    return c.html(
      html("OIDC login failed", "Login transaction cookie missing or mismatched."),
      400,
    );
  }

  prunePendingLogins();
  const pending = pendingLogins.get(query.state);
  pendingLogins.delete(query.state);
  if (!pending) {
    return c.html(html("OIDC login failed", "Login state expired or was not recognized."), 400);
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
        return c.html(html("Operator credentials required", result.reason), 403);
      }
      return c.html(
        html(
          "OIDC login failed",
          result.reason === "missing_email_claim"
            ? "The provider did not return an email claim."
            : "The login response could not be validated.",
        ),
        400,
      );
    }

    const session = await createSession(result.user, tokenSet, c.req.raw);
    setSessionCookie(c, session.id, session.expiresAt);
    return c.redirect(webRedirectUrl(pending.returnTo), 302);
  } catch (error) {
    logAuthCallbackError(error);
    return c.html(html("OIDC login failed", "The login response could not be validated."), 400);
  }
});

authRoutes.post("/logout", async (c) => {
  const session = await destroySession(c);
  let redirectTo = webRedirectUrl("/login");
  if (session?.idToken && !getAuthConfig().disabled) {
    await getOidcClient();
    redirectTo = endSessionUrl(session.idToken)?.toString() ?? redirectTo;
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
