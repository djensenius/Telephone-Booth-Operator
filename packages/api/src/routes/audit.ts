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

// `AuditLog.id` is a UUID column, so a forged cursor carrying anything else
// must be rejected here rather than reaching Prisma as a malformed query.
const keysetFromCursor = (raw: string): Record<string, unknown>[] | null => {
  const decoded = decodeCursor(raw);
  if (!decoded || !z.guid().safeParse(decoded.id).success) return null;
  // Tuple comparison over (createdAt, id) — matches the composite index and
  // stays stable when several rows share a timestamp.
  return [
    { createdAt: { lt: new Date(decoded.timestamp) } },
    { createdAt: new Date(decoded.timestamp), id: { lt: decoded.id } },
  ];
};

const listQuerySchema = z.object({
  // Action prefix: `message.` is the whole family, `message.approve` just
  // approvals, `auth.login` logins including the denied and failed variants.
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
  // Always a prefix. Action names are hierarchical, so this is what callers
  // mean: `auth.login` should include `auth.login.denied` without also
  // dragging in `auth.logout`, which an exact match cannot express and a
  // trailing-dot-only rule gets wrong.
  if (action) where.action = { startsWith: action };
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
    const keyset = keysetFromCursor(cursor);
    if (!keyset) return c.json({ error: "invalid_cursor" }, 400);
    // `createdAt` may already be constrained by since/until, so nest the
    // keyset under AND rather than overwriting it.
    where.AND = [{ OR: keyset }];
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

// Convenience view used by the message review screen: the trail for one
// target, newest first, paginated the same way as the list endpoint so a
// long-lived target's older history stays reachable.
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
    z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    }),
  ),
  async (c) => {
    const { targetType, targetId } = c.req.valid("param");
    const { cursor, limit } = c.req.valid("query");

    const where: Record<string, unknown> = { targetType, targetId };
    if (cursor) {
      const keyset = keysetFromCursor(cursor);
      if (!keyset) return c.json({ error: "invalid_cursor" }, 400);
      where.OR = keyset;
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
  },
);
