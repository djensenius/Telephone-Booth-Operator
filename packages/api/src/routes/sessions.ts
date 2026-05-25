import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { db } from "../lib/db.js";
import { serializeBoothEvent, serializeCallSession } from "../lib/serializers.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

const listQuerySchema = z.object({
  boothId: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const sessionsRouter = new Hono<{ Variables: AuthVariables }>();

sessionsRouter.get("/", requireOperator(), zValidator("query", listQuerySchema), async (c) => {
  const { boothId, cursor, limit } = c.req.valid("query");
  const where: Record<string, unknown> = {};
  if (boothId) where.boothId = boothId;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return c.json({ error: "invalid_cursor" }, 400);
    where.OR = [
      { startedAt: { lt: new Date(decoded.timestamp) } },
      { startedAt: new Date(decoded.timestamp), id: { lt: decoded.id } },
    ];
  }
  const rows = await db.callSession.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const items = rows.slice(0, limit).map(serializeCallSession);
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          timestamp: items[items.length - 1]!.startedAt,
          id: items[items.length - 1]!.id,
        })
      : null;
  return c.json({ items, nextCursor });
});

sessionsRouter.get("/:id", requireOperator(), async (c) => {
  const id = c.req.param("id");
  const session = await db.callSession.findUnique({ where: { id } });
  if (!session) return c.json({ error: "not_found" }, 404);
  const events = await db.boothEvent.findMany({
    where: { sessionId: id },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  return c.json({
    ...serializeCallSession(session),
    events: events.map(serializeBoothEvent),
  });
});

export { sessionsRouter };
