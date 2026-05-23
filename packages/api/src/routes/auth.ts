import { randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OperatorMeSchema } from "@telephone-booth-operator/shared";
import { z } from "zod";
import { db } from "../lib/db.js";
import { getAuthConfig, getRequiredOidcConfig } from "../lib/config.js";
import {
  buildAuthorizationUrl,
  endSessionUrl,
  exchangeCode,
  getOidcClient,
  type IDTokenClaims,
} from "../lib/oidc.js";
import {
  createSession,
  destroySession,
  readSession,
  setSessionCookie,
  type AuthVariables,
} from "../lib/session.js";

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

const html = (title: string, detail: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p>${detail}</p></body>
</html>`;

const claimString = (claims: IDTokenClaims, name: string): string | null => {
  const value = claims[name];
  return typeof value === "string" && value.trim() ? value : null;
};

export const groupsFromClaims = (claims: IDTokenClaims): string[] => {
  const groups = claims.groups;
  if (!Array.isArray(groups)) return [];
  return groups.filter((group): group is string => typeof group === "string");
};

const pictureFromClaims = (claims: IDTokenClaims): string | null => {
  const picture = claimString(claims, "picture");
  if (!picture) return null;
  try {
    return new URL(picture).toString();
  } catch {
    return null;
  }
};

export const validateAuthorization = (
  claims: IDTokenClaims,
  groups: string[],
): string | null => {
  const config = getRequiredOidcConfig();
  const email = claimString(claims, "email")?.toLowerCase();

  if (config.allowedEmails.length > 0 && (!email || !config.allowedEmails.includes(email))) {
    return "This email is not authorized for this booth.";
  }

  if (
    config.allowedGroups.length > 0 &&
    !groups.some((group) => config.allowedGroups.includes(group))
  ) {
    return "This account is not in an authorized operator group.";
  }

  return null;
};

const operatorMe = (session: Awaited<ReturnType<typeof readSession>>) => {
  if (!session) return null;
  const groups = Array.isArray(session.user.groups)
    ? session.user.groups.filter((group): group is string => typeof group === "string")
    : [];
  const payload = {
    id: session.user.oidcSub,
    email: session.user.email,
    name: session.user.name,
    groups,
    providerName: getAuthConfig().providerName,
    ...(session.user.picture ? { picture: session.user.picture } : {}),
  };
  return OperatorMeSchema.parse(payload);
};

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

authRoutes.get("/login", zValidator("query", loginQuerySchema), async (c) => {
  if (getAuthConfig().disabled) {
    return c.html(html("Authentication disabled", "AUTH_DISABLED=true is enabled for local development."), 503);
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
  return c.redirect(buildAuthorizationUrl(state, nonce, codeVerifier).toString(), 302);
});

authRoutes.get("/callback", zValidator("query", callbackQuerySchema), async (c) => {
  const query = c.req.valid("query");
  if (query.error) {
    return c.html(html("OIDC login failed", query.error_description ?? query.error), 400);
  }
  if (!query.code || !query.state) {
    return c.html(html("OIDC login failed", "Missing code or state."), 400);
  }

  prunePendingLogins();
  const pending = pendingLogins.get(query.state);
  pendingLogins.delete(query.state);
  if (!pending) {
    return c.html(html("OIDC login failed", "Login state expired or was not recognized."), 400);
  }

  try {
    const tokenSet = await exchangeCode(
      new URL(c.req.url),
      pending.codeVerifier,
      query.state,
      pending.nonce,
    );
    const groups = groupsFromClaims(tokenSet.claims);
    const authorizationError = validateAuthorization(tokenSet.claims, groups);
    if (authorizationError) {
      return c.html(html("Operator credentials required", authorizationError), 403);
    }

    const email = claimString(tokenSet.claims, "email");
    if (!email) {
      return c.html(html("OIDC login failed", "The provider did not return an email claim."), 400);
    }

    const now = new Date();
    const name =
      claimString(tokenSet.claims, "name") ??
      claimString(tokenSet.claims, "preferred_username") ??
      email;
    const picture = pictureFromClaims(tokenSet.claims);
    const user = await db.operatorUser.upsert({
      where: { oidcSub: tokenSet.claims.sub },
      create: {
        id: tokenSet.claims.sub,
        oidcSub: tokenSet.claims.sub,
        email,
        name,
        groups,
        picture,
        lastLoginAt: now,
        lastSeenAt: now,
      },
      update: {
        email,
        name,
        groups,
        picture,
        lastLoginAt: now,
        lastSeenAt: now,
      },
    });

    const session = await createSession(user, tokenSet, c.req.raw);
    setSessionCookie(c, session.id, session.expiresAt);
    return c.redirect(pending.returnTo, 302);
  } catch {
    return c.html(html("OIDC login failed", "The login response could not be validated."), 400);
  }
});

authRoutes.post("/logout", async (c) => {
  const session = await destroySession(c);
  let redirectTo = getRequiredOidcConfig().postLogoutRedirectUri ?? "/";
  if (session?.idToken) {
    await getOidcClient();
    redirectTo = endSessionUrl(session.idToken)?.toString() ?? redirectTo;
  }
  return c.redirect(redirectTo, 302);
});

authRoutes.get("/me", async (c) => {
  const session = await readSession(c);
  const me = operatorMe(session);
  if (!me) {
    return c.json({ error: "unauthenticated", login_url: "/v1/auth/login" }, 401);
  }
  return c.json(me);
});

export const resetAuthRouteStateForTests = (): void => {
  pendingLogins.clear();
};
