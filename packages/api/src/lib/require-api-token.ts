import type { ApiToken } from "../generated/prisma/client.js";
import type { MiddlewareHandler } from "hono";
import type { ApiTokenScope } from "@telephone-booth-operator/shared";
import { verifyToken } from "./api-tokens.js";

export type ApiTokenVariables = {
  apiToken: ApiToken;
  apiTokenId: string;
};

const bearerTokenFromHeader = (authorization: string | undefined): string | null => {
  if (!authorization) return null;
  const [scheme, token, extra] = authorization.trim().split(/\s+/);
  if (extra || scheme !== "Bearer" || !token) return null;
  return token;
};

// The token must carry one of the required scopes. Defaults to "operator" so
// booth/phone and native-operator routes reject worker/monitor credentials.
export const requireApiToken =
  (
    requiredScope: ApiTokenScope | readonly ApiTokenScope[] = "operator",
  ): MiddlewareHandler<{ Variables: ApiTokenVariables }> =>
  async (c, next) => {
    const plaintext = bearerTokenFromHeader(c.req.header("authorization"));
    if (!plaintext) return c.json({ error: "invalid_token" }, 401);

    const token = await verifyToken(plaintext);
    if (!token) return c.json({ error: "invalid_token" }, 401);

    // Set before the scope check so the audit trail attributes a denied write
    // to the token that actually presented it rather than to "anonymous".
    c.set("apiToken", token);
    c.set("apiTokenId", token.id);

    const requiredScopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
    if (!requiredScopes.some((scope) => token.scope === scope)) {
      return c.json({ error: "insufficient_scope" }, 403);
    }
    await next();
  };
