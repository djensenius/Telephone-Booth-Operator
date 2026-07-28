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

// The token must carry exactly `requiredScope`. Defaults to "operator" so the
// booth/phone and native-operator routes reject worker-scoped tokens; the push
// worker router opts in with `requireApiToken("worker")`.
export const requireApiToken =
  (
    requiredScope: ApiTokenScope = "operator",
  ): MiddlewareHandler<{ Variables: ApiTokenVariables }> =>
  async (c, next) => {
    const plaintext = bearerTokenFromHeader(c.req.header("authorization"));
    if (!plaintext) return c.json({ error: "invalid_token" }, 401);

    const token = await verifyToken(plaintext);
    if (!token) return c.json({ error: "invalid_token" }, 401);

    if (token.scope !== requiredScope) {
      return c.json({ error: "insufficient_scope" }, 403);
    }

    c.set("apiToken", token);
    c.set("apiTokenId", token.id);
    await next();
  };
