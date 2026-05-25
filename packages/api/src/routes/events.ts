// Booth observability event log + derived call sessions.
//
// - POST /v1/events     : bulk, idempotent on (boothId, eventId). Lazily
//                         upserts a CallSession when call_started /
//                         call_ended events arrive.
// - GET  /v1/events     : operator-auth, cursor-paginated, filterable.
// - GET  /v1/events/stream : operator-cookie-auth (SSE) live tail.

import { zValidator } from "@hono/zod-validator";
import {
  BOOTH_EVENT_BATCH_MAX,
  BoothEventBatchSchema,
  BoothEventTypeSchema,
  CallOutcomeSchema,
  type BoothEvent,
  type BoothEventRecord,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fanOutNotification } from "../lib/apns.js";
import { Broadcaster } from "../lib/broadcaster.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { db } from "../lib/db.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { serializeBoothEvent } from "../lib/serializers.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

export const eventsBroadcaster = new Broadcaster<BoothEventRecord>();

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const listQuerySchema = z.object({
  boothId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  type: z
    .union([BoothEventTypeSchema, z.array(BoothEventTypeSchema)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
  sessionId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const streamQuerySchema = z.object({
  boothId: z.string().min(1).optional(),
  type: z
    .union([BoothEventTypeSchema, z.array(BoothEventTypeSchema)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
  sessionId: z.string().uuid().optional(),
});

const eventsRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

// Cookie-only SSE stream. The booth-side API token is never accepted here
// because the browser EventSource consumer can only send a same-origin
// cookie, not a Bearer header.
eventsRouter.get("/stream", requireOperator(), zValidator("query", streamQuerySchema), (c) => {
  const filters = c.req.valid("query");
  return streamSSE(c, async (stream) => {
    const clientId = randomUUID();
    let done = false;
    const sendEvent = (event: BoothEventRecord): void => {
      if (done) return;
      if (filters.boothId && event.boothId !== filters.boothId) return;
      if (filters.type && !filters.type.includes(event.type)) return;
      if (filters.sessionId && event.sessionId !== filters.sessionId) return;
      // Fire-and-forget; streamSSE buffers internally.
      void stream.writeSSE({
        id: event.id,
        event: "booth-event",
        data: JSON.stringify(event),
      });
    };
    eventsBroadcaster.subscribe(clientId, sendEvent);
    stream.onAbort(() => {
      done = true;
      eventsBroadcaster.unsubscribe(clientId);
    });
    // Initial comment so clients see a successful response immediately.
    await stream.writeSSE({ event: "ready", data: "ok" });
    // Heartbeat keeps proxies from idle-closing the connection.
    while (!done) {
      await stream.sleep(15_000);
      if (done) break;
      await stream.writeSSE({ event: "ping", data: new Date().toISOString() });
    }
  });
});

eventsRouter.get("/", requireOperator(), zValidator("query", listQuerySchema), async (c) => {
  const { boothId, since, until, type, sessionId, cursor, limit } = c.req.valid("query");
  const where: Record<string, unknown> = {};
  if (boothId) where.boothId = boothId;
  if (sessionId) where.sessionId = sessionId;
  if (type && type.length > 0) where.type = type.length === 1 ? type[0] : { in: type };
  if (since || until) {
    where.occurredAt = {
      ...(since ? { gte: new Date(since) } : {}),
      ...(until ? { lte: new Date(until) } : {}),
    };
  }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return c.json({ error: "invalid_cursor" }, 400);
    // We can't use Prisma's `cursor` for a composite non-primary index, so
    // emit a tuple comparison via raw `where` instead.
    where.OR = [
      { receivedAt: { lt: new Date(decoded.timestamp) } },
      {
        receivedAt: new Date(decoded.timestamp),
        id: { lt: decoded.id },
      },
    ];
  }
  const rows = await db.boothEvent.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const items = rows.slice(0, limit).map(serializeBoothEvent);
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          timestamp: items[items.length - 1]!.receivedAt,
          id: items[items.length - 1]!.id,
        })
      : null;
  return c.json({ items, nextCursor });
});

type StoredCallSession = {
  id: string;
  boothId: string;
  bootId: string;
  startedAt: Date;
  endedAt: Date | null;
  digitsDialed: string | null;
  outcome: string | null;
  recordingId: string | null;
  durationMs: number | null;
};

// Helpers for session derivation. Both sides treat absent fields as no-op
// updates rather than null-overwrites.
function callStartedData(event: BoothEvent): Partial<StoredCallSession> | null {
  if (event.type !== "call_started" || !event.sessionId) return null;
  return {
    id: event.sessionId,
    boothId: event.boothId,
    bootId: event.bootId,
    startedAt: new Date(event.occurredAt),
  };
}

function callEndedData(event: BoothEvent): Partial<StoredCallSession> | null {
  if (event.type !== "call_ended" || !event.sessionId) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const outcomeRaw = payload.outcome ?? payload.call_outcome;
  const outcome =
    typeof outcomeRaw === "string" && CallOutcomeSchema.safeParse(outcomeRaw).success
      ? outcomeRaw
      : null;
  const durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : null;
  const digitsDialed = typeof payload.digits_dialed === "string" ? payload.digits_dialed : null;
  const recordingId =
    event.recordingId ?? (typeof payload.recording_id === "string" ? payload.recording_id : null);
  return {
    id: event.sessionId,
    boothId: event.boothId,
    bootId: event.bootId,
    endedAt: new Date(event.occurredAt),
    outcome,
    durationMs,
    digitsDialed,
    recordingId,
  };
}

eventsRouter.post("/", requireApiToken(), zValidator("json", BoothEventBatchSchema), async (c) => {
  const { events } = c.req.valid("json");
  if (events.length === 0) return c.json({ accepted: 0, duplicates: 0 });
  if (events.length > BOOTH_EVENT_BATCH_MAX) {
    return c.json({ error: "batch_too_large", limit: BOOTH_EVENT_BATCH_MAX }, 400);
  }

  // 1. Upsert any call sessions the batch references. We do this *before*
  //    the events insert so the FK is satisfied.
  const sessionInits = new Map<string, Partial<StoredCallSession>>();
  for (const event of events) {
    const start = callStartedData(event);
    if (start) sessionInits.set(start.id!, { ...sessionInits.get(start.id!), ...start });
    const end = callEndedData(event);
    if (end) sessionInits.set(end.id!, { ...sessionInits.get(end.id!), ...end });
  }
  for (const init of sessionInits.values()) {
    if (!init.id || !init.boothId || !init.bootId) continue;
    const startedAt = init.startedAt ?? new Date();
    await db.callSession.upsert({
      where: { id: init.id },
      create: {
        id: init.id,
        boothId: init.boothId,
        bootId: init.bootId,
        startedAt,
        endedAt: init.endedAt ?? null,
        digitsDialed: init.digitsDialed ?? null,
        outcome: init.outcome ?? null,
        recordingId: init.recordingId ?? null,
        durationMs: init.durationMs ?? null,
      },
      update: {
        // Never overwrite startedAt; never null-out fields that the event
        // didn't carry.
        ...(init.endedAt ? { endedAt: init.endedAt } : {}),
        ...(init.digitsDialed !== undefined && init.digitsDialed !== null
          ? { digitsDialed: init.digitsDialed }
          : {}),
        ...(init.outcome ? { outcome: init.outcome } : {}),
        ...(init.recordingId ? { recordingId: init.recordingId } : {}),
        ...(init.durationMs !== undefined && init.durationMs !== null
          ? { durationMs: init.durationMs }
          : {}),
      },
    });
  }

  // 2. Bulk insert the events idempotently on (boothId, eventId).
  const rows = events.map((event) => ({
    eventId: event.eventId,
    boothId: event.boothId,
    bootId: event.bootId,
    type: event.type,
    occurredAt: new Date(event.occurredAt),
    sessionId: event.sessionId ?? null,
    recordingId: event.recordingId ?? null,
    payload: event.payload ?? {},
  }));
  const inserted = await db.boothEvent.createMany({
    data: rows,
    skipDuplicates: true,
  });
  const accepted = inserted.count;
  const duplicates = events.length - accepted;

  // 3. Broadcast newly-inserted events to SSE subscribers. We fetch them
  //    back so subscribers see the operator-stamped `id` and `receivedAt`.
  if (accepted > 0) {
    const recent = await db.boothEvent.findMany({
      where: {
        OR: events.map((event) => ({ boothId: event.boothId, eventId: event.eventId })),
      },
      orderBy: { receivedAt: "asc" },
    });
    for (const row of recent.slice(-accepted)) {
      const record = serializeBoothEvent(row);
      eventsBroadcaster.broadcast(record);
      // Best-effort push fan-out for notable event types. Failures are
      // swallowed inside `fanOutNotification`; we don't want a dead
      // APNs config to break /v1/events ingestion.
      if (record.type === "call_started") {
        void fanOutNotification({
          preferenceKey: "callStarted",
          title: "Call started",
          body: "Someone picked up the booth.",
          threadId: `booth:${record.boothId}`,
          category: "BOOTH_CALL",
          data: { eventId: record.id, sessionId: record.sessionId ?? null },
        });
      }
    }
  }

  return c.json({ accepted, duplicates });
});

export { eventsRouter };
