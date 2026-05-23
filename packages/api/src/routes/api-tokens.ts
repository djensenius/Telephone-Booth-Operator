import { zValidator } from "@hono/zod-validator";
import {
  ApiTokenCreatedSchema,
  ApiTokenSchema,
  ApiTokenUsageBucketSchema,
  CreateApiTokenRequestSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { generateToken, invalidateApiTokenCache } from "../lib/api-tokens.js";
import { db } from "../lib/db.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

const idParamSchema = z.object({ id: z.string().uuid() });
const usageQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

const toSummary = (token: {
  id: string;
  name: string;
  last4: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) =>
  ApiTokenSchema.parse({
    id: token.id,
    name: token.name,
    last4: token.last4,
    createdAt: token.createdAt.toISOString(),
    expiresAt: toIso(token.expiresAt),
    lastUsedAt: toIso(token.lastUsedAt),
    revokedAt: toIso(token.revokedAt),
  });

const selectedTokenFields = {
  id: true,
  name: true,
  last4: true,
  createdAt: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

const expiresAtFromDays = (expiresInDays: number | undefined): Date | null => {
  if (expiresInDays === undefined) return null;
  return new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
};

const usageBuckets = (lastUsedAt: Date | null, days: number) => {
  if (!lastUsedAt) return [];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  if (lastUsedAt.getTime() < since) return [];
  return [
    ApiTokenUsageBucketSchema.parse({
      date: lastUsedAt.toISOString().slice(0, 10),
      count: 1,
    }),
  ];
};

const apiTokensRouter = new Hono<{ Variables: AuthVariables }>();

apiTokensRouter.use("*", requireOperator());

apiTokensRouter.get("/", async (c) => {
  const user = c.get("user");
  const tokens = await db.apiToken.findMany({
    where: { createdByUserId: user.id },
    orderBy: { createdAt: "desc" },
    select: selectedTokenFields,
  });
  return c.json(tokens.map(toSummary));
});

apiTokensRouter.post("/", zValidator("json", CreateApiTokenRequestSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const generated = await generateToken();
  const token = await db.apiToken.create({
    data: {
      name: body.name,
      lookupId: generated.lookupId,
      tokenHash: generated.hash,
      last4: generated.last4,
      createdByUserId: user.id,
      expiresAt: expiresAtFromDays(body.expiresInDays),
    },
    select: selectedTokenFields,
  });

  return c.json(
    ApiTokenCreatedSchema.parse({
      ...toSummary(token),
      plaintext: generated.plaintext,
    }),
    201,
  );
});

apiTokensRouter.delete("/:id", zValidator("param", idParamSchema), async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const existing = await db.apiToken.findFirst({
    where: { id, createdByUserId: user.id },
    select: { id: true },
  });
  if (existing) {
    await db.apiToken.updateMany({
      where: { id, createdByUserId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    invalidateApiTokenCache(id);
  }
  return c.body(null, 204);
});

apiTokensRouter.get(
  "/:id/usage",
  zValidator("param", idParamSchema),
  zValidator("query", usageQuerySchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { days } = c.req.valid("query");
    const token = await db.apiToken.findFirst({
      where: { id, createdByUserId: user.id },
      select: { lastUsedAt: true },
    });
    if (!token) return c.json({ error: "not_found" }, 404);
    return c.json(usageBuckets(token.lastUsedAt, days));
  },
);

export default apiTokensRouter;
