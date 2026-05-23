import type { ApiToken } from "@prisma/client";
import type { MiddlewareHandler } from "hono";
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

export const requireApiToken = (): MiddlewareHandler<{ Variables: ApiTokenVariables }> =>
  async (c, next) => {
    const plaintext = bearerTokenFromHeader(c.req.header("authorization"));
    if (!plaintext) return c.json({ error: "invalid_token" }, 401);

    const token = await verifyToken(plaintext);
    if (!token) return c.json({ error: "invalid_token" }, 401);

    c.set("apiToken", token);
    c.set("apiTokenId", token.id);
    await next();
  };
