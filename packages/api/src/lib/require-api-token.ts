import type { ApiToken } from "@prisma/client";
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

// When `requiredScope` is provided the token must carry exactly that scope.
// Omitting it accepts any active token (used by legacy booth/phone routes that
// predate scoping and continue to run with the default "operator" scope).
export const requireApiToken =
  (requiredScope?: ApiTokenScope): MiddlewareHandler<{ Variables: ApiTokenVariables }> =>
  async (c, next) => {
    const plaintext = bearerTokenFromHeader(c.req.header("authorization"));
    if (!plaintext) return c.json({ error: "invalid_token" }, 401);

    const token = await verifyToken(plaintext);
    if (!token) return c.json({ error: "invalid_token" }, 401);

    if (requiredScope && token.scope !== requiredScope) {
      return c.json({ error: "insufficient_scope" }, 403);
    }

    c.set("apiToken", token);
    c.set("apiTokenId", token.id);
    await next();
  };
