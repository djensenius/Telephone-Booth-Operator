// Audit trail read API (issue #123).
//
// Admin-only: the trail records who did what, from which IP, and when, across
// every operator. Ordinary operators can see their own actions' effects in the
// resources themselves; the aggregate trail is a privileged view.
//
// The log is append-only — there is deliberately no create/update/delete
// surface here. Rows are written by the `auditWrites()` middleware and aged
// out by `lib/audit-pruner.ts`.

import { zValidator } from "@hono/zod-validator";
import { AuditActorTypeSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { db } from "../lib/db.js";
import { serializeAuditLog } from "../lib/serializers.js";
import { requireAdmin, type AuthVariables } from "../lib/session.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const listQuerySchema = z.object({
  // Exact action (`message.approve`) or dotted prefix (`message.`).
  action: z.string().min(1).max(128).optional(),
  actorType: AuditActorTypeSchema.optional(),
  actorUserId: z.string().min(1).max(255).optional(),
  targetType: z.string().min(1).max(64).optional(),
  targetId: z.string().min(1).max(255).optional(),
  ip: z.string().min(1).max(64).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export const auditRouter = new Hono<{ Variables: AuthVariables }>();

auditRouter.get("/", requireAdmin(), zValidator("query", listQuerySchema), async (c) => {
  const { action, actorType, actorUserId, targetType, targetId, ip, since, until, cursor, limit } =
    c.req.valid("query");

  const where: Record<string, unknown> = {};
  // A trailing dot means "this family of actions"; anything else is exact.
  if (action) where.action = action.endsWith(".") ? { startsWith: action } : action;
  if (actorType) where.actorType = actorType;
  if (actorUserId) where.actorUserId = actorUserId;
  if (targetType) where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  if (ip) where.ip = ip;
  if (since || until) {
    where.createdAt = {
      ...(since ? { gte: new Date(since) } : {}),
      ...(until ? { lte: new Date(until) } : {}),
    };
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return c.json({ error: "invalid_cursor" }, 400);
    // Tuple comparison over (createdAt, id) — matches the composite index and
    // stays stable when several rows share a timestamp.
    const keyset = [
      { createdAt: { lt: new Date(decoded.timestamp) } },
      { createdAt: new Date(decoded.timestamp), id: { lt: decoded.id } },
    ];
    // `createdAt` may already be constrained by since/until, so nest the
    // keyset under AND rather than overwriting it.
    where.AND = keyset.length > 0 ? [{ OR: keyset }] : [];
  }

  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const items = rows.slice(0, limit).map(serializeAuditLog);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ timestamp: last.createdAt, id: last.id }) : null;
  return c.json({ items, nextCursor });
});

// Convenience view used by the message review screen: the full trail for one
// target, newest first.
auditRouter.get(
  "/targets/:targetType/:targetId",
  requireAdmin(),
  zValidator(
    "param",
    z.object({
      targetType: z.string().min(1).max(64),
      targetId: z.string().min(1).max(255),
    }),
  ),
  zValidator(
    "query",
    z.object({ limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50) }),
  ),
  async (c) => {
    const { targetType, targetId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const rows = await db.auditLog.findMany({
      where: { targetType, targetId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return c.json({ items: rows.map(serializeAuditLog), nextCursor: null });
  },
);
