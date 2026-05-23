import { zValidator } from "@hono/zod-validator";
import { StatusUpdateSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { statusBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { defaultStatus, serializeStatus } from "../lib/serializers.js";
import type { AuthVariables } from "../lib/session.js";

const historyQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const statusRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

statusRouter.get("/", async (c) => {
  // Public for now: the operator UI reads this before establishing its WS and
  // health probes use it without an auth challenge. TODO: require auth once the
  // phone/operator clients are both ready to send credentials here.
  const latest = await db.boothStatusSnapshot.findFirst({ orderBy: { updatedAt: "desc" } });
  return c.json(latest ? serializeStatus(latest) : defaultStatus());
});

statusRouter.put("/", requireApiToken(), zValidator("json", StatusUpdateSchema), async (c) => {
  const update = c.req.valid("json");
  const snapshot = await db.boothStatusSnapshot.create({
    data: {
      state: update.state,
      currentQuestionId: update.currentQuestionId ?? null,
      currentMessageId: update.currentMessageId ?? null,
      lastError: update.lastError ?? null,
      updatedAt: update.updatedAt ? new Date(update.updatedAt) : new Date(),
    },
  });
  statusBroadcaster.broadcast(serializeStatus(snapshot));
  return c.body(null, 204);
});

statusRouter.get("/history", zValidator("query", historyQuerySchema), async (c) => {
  const { since, limit } = c.req.valid("query");
  const snapshots = await db.boothStatusSnapshot.findMany({
    where: since ? { updatedAt: { gte: new Date(since) } } : {},
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  return c.json({ items: snapshots.map(serializeStatus) });
});
