// Shared helpers that translate verified OIDC claims into an
// `OperatorUser` row. Used by both the browser cookie-session callback in
// `routes/auth.ts` and the mobile bearer-token middleware in
// `lib/bearer-auth.ts` so the authorization + upsert logic stays in one
// place.

import type { OperatorUser } from "@prisma/client";
import { getAuthConfig, getRequiredOidcConfig } from "./config.js";
import { db } from "./db.js";
import type { IDTokenClaims } from "./oidc.js";

export const claimString = (claims: IDTokenClaims, name: string): string | null => {
  const value = claims[name];
  return typeof value === "string" && value.trim() ? value : null;
};

export const groupsFromClaims = (claims: IDTokenClaims): string[] => {
  const groups = claims.groups;
  if (!Array.isArray(groups)) return [];
  return groups.filter((group): group is string => typeof group === "string");
};

// Whether the given groups grant the operator **admin** tier. Derived from the
// live group claim on every login (cookie flow) and every bearer request
// (mobile flow), so removing a user from the admin group takes effect without
// waiting for a stored flag to be recomputed.
export const isAdminFromGroups = (groups: string[]): boolean => {
  const { adminGroups } = getRequiredOidcConfig();
  if (adminGroups.length === 0) return false;
  return groups.some((group) => adminGroups.includes(group));
};

export const pictureFromClaims = (claims: IDTokenClaims): string | null => {
  const picture = claimString(claims, "picture");
  if (!picture) return null;
  try {
    return new URL(picture).toString();
  } catch {
    return null;
  }
};

export const validateAuthorization = (claims: IDTokenClaims, groups: string[]): string | null => {
  const config = getRequiredOidcConfig();
  const email = claimString(claims, "email")?.toLowerCase();

  // Fail closed: if no allow-lists are configured, reject access rather than
  // silently granting operator privileges to any authenticated user.
  if (config.allowedGroups.length === 0 && config.allowedEmails.length === 0) {
    return "No operator allow-list is configured. Access denied.";
  }

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

export type AuthorizeAndUpsertOptions = {
  // When true the resulting upsert also updates `lastLoginAt` — set this on
  // interactive auth-code logins, leave false for token-validation paths
  // (e.g. mobile bearer requests) so we don't churn `lastLoginAt` per call.
  markLogin?: boolean;
  now?: Date;
};

export type AuthorizeAndUpsertResult =
  | { ok: true; user: OperatorUser; groups: string[] }
  | { ok: false; status: 400 | 403; reason: string };

// Validate operator-side authorization (groups/emails) and upsert the
// `OperatorUser` row keyed on `oidcSub`. Mirrors the logic the browser
// callback performs after a successful authorization-code exchange.
export const authorizeAndUpsertOperator = async (
  claims: IDTokenClaims,
  options: AuthorizeAndUpsertOptions = {},
): Promise<AuthorizeAndUpsertResult> => {
  const now = options.now ?? new Date();

  if (getAuthConfig().disabled) {
    return { ok: false, status: 403, reason: "auth_disabled" };
  }

  const groups = groupsFromClaims(claims);
  const authorizationError = validateAuthorization(claims, groups);
  if (authorizationError) {
    return { ok: false, status: 403, reason: authorizationError };
  }

  const email = claimString(claims, "email");
  if (!email) {
    return { ok: false, status: 400, reason: "missing_email_claim" };
  }

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  if (!sub) {
    return { ok: false, status: 400, reason: "missing_sub_claim" };
  }

  const name = claimString(claims, "name") ?? claimString(claims, "preferred_username") ?? email;
  const picture = pictureFromClaims(claims);
  const isAdmin = isAdminFromGroups(groups);
  const updateData: {
    email: string;
    name: string;
    groups: string[];
    picture: string | null;
    isAdmin: boolean;
    lastSeenAt: Date;
    lastLoginAt?: Date;
  } = {
    email,
    name,
    groups,
    picture,
    isAdmin,
    lastSeenAt: now,
  };
  if (options.markLogin) updateData.lastLoginAt = now;

  const user = await db.operatorUser.upsert({
    where: { oidcSub: sub },
    create: {
      id: sub,
      oidcSub: sub,
      email,
      name,
      groups,
      picture,
      isAdmin,
      lastLoginAt: now,
      lastSeenAt: now,
    },
    update: updateData,
  });

  return { ok: true, user, groups };
};

export type RevalidationOutcome = { ok: true; user?: OperatorUser } | { ok: false; reason: string };

// Re-evaluate an existing operator's authorization from a fresh set of claims
// (typically a userinfo response) during periodic session revalidation.
//
// Only the 403 "no longer in an operator group / email" case revokes access.
// A userinfo response may legitimately omit the `groups` claim (depending on
// the provider's scope mapping) or other fields; in that case we cannot
// re-evaluate group authorization, so we treat the successful response as a
// liveness confirmation and leave the stored authorization untouched rather
// than logging out a still-valid operator.
export const revalidateOperatorFromClaims = async (
  claims: IDTokenClaims,
): Promise<RevalidationOutcome> => {
  if (!Array.isArray(claims.groups)) {
    return { ok: true };
  }
  const result = await authorizeAndUpsertOperator(claims);
  if (result.ok) return { ok: true, user: result.user };
  // Only an authorization failure (403) should end the session. A 400 means
  // the userinfo response lacked the claim shape we need to re-authorize, so
  // keep the session (liveness was already confirmed by a successful call).
  if (result.status === 403) return { ok: false, reason: result.reason };
  return { ok: true };
};
