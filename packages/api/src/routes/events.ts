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
  BoothReportedCallOutcomeSchema,
  InstallationScopeSchema,
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
import {
  runWithOpenEra,
  requireActiveInstallation,
  resolveInstallationScope,
  scopeWhere,
  ROLLOVER_OUTCOME,
} from "../lib/installation.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { serializeBoothEvent } from "../lib/serializers.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

export const eventsBroadcaster = new Broadcaster<BoothEventRecord>();

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const sleepUnref = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

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
  sessionId: z.guid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  installationId: InstallationScopeSchema.optional(),
});

const streamQuerySchema = z.object({
  boothId: z.string().min(1).optional(),
  type: z
    .union([BoothEventTypeSchema, z.array(BoothEventTypeSchema)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
  sessionId: z.guid().optional(),
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
      await sleepUnref(15_000);
      if (done) break;
      await stream.writeSSE({ event: "ping", data: new Date().toISOString() });
    }
  });
});

eventsRouter.get("/", requireOperator(), zValidator("query", listQuerySchema), async (c) => {
  const { boothId, since, until, type, sessionId, cursor, limit, installationId } =
    c.req.valid("query");
  const where: Record<string, unknown> = scopeWhere(await resolveInstallationScope(installationId));
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
  version: string | null;
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
    version: event.version ?? null,
  };
}

function callEndedData(event: BoothEvent): Partial<StoredCallSession> | null {
  if (event.type !== "call_ended" || !event.sessionId) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const outcomeRaw = payload.outcome ?? payload.call_outcome;
  const outcome =
    typeof outcomeRaw === "string" && BoothReportedCallOutcomeSchema.safeParse(outcomeRaw).success
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
    version: event.version ?? null,
  };
}

eventsRouter.post("/", requireApiToken(), zValidator("json", BoothEventBatchSchema), async (c) => {
  const { events } = c.req.valid("json");
  if (events.length === 0) return c.json({ accepted: 0, duplicates: 0 });
  if (events.length > BOOTH_EVENT_BATCH_MAX) {
    return c.json({ error: "batch_too_large", limit: BOOTH_EVENT_BATCH_MAX }, 400);
  }

  // 1. Collect session derivation data from the batch.
  const sessionInits = new Map<string, Partial<StoredCallSession>>();
  for (const event of events) {
    const start = callStartedData(event);
    if (start) sessionInits.set(start.id!, { ...sessionInits.get(start.id!), ...start });
    const end = callEndedData(event);
    if (end) sessionInits.set(end.id!, { ...sessionInits.get(end.id!), ...end });
  }

  const installationId = await requireActiveInstallation();

  // A late `call_ended` can arrive for a session the rollover already closed
  // out. Those sessions belong to a frozen era: their outcome and `endedAt`
  // must not be rewritten, and the events that reference them belong with the
  // session rather than with whatever era happens to be open now.
  const referencedSessionIds = [
    ...new Set(
      events.map((event) => event.sessionId).filter((id): id is string => typeof id === "string"),
    ),
  ];
  const knownSessions =
    referencedSessionIds.length > 0
      ? await db.callSession.findMany({
          where: { id: { in: referencedSessionIds } },
          select: { id: true, installationId: true, endedAt: true },
        })
      : [];
  const sessionEra = new Map(knownSessions.map((row) => [row.id, row]));

  // Whether the session's era is closed is asked of the database, not inferred
  // by comparing against the cached active id: that cache is per-replica and
  // briefly stale, which would let a straggler through on the replica that did
  // not serve the admin's rollover.
  const eraIds = [
    ...new Set(
      knownSessions
        .map((row) => row.installationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const endedEras = new Set(
    eraIds.length > 0
      ? (
          await db.installation.findMany({
            where: { id: { in: eraIds }, endedAt: { not: null } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [],
  );
  const frozen = (sessionId: string): boolean => {
    const known = sessionEra.get(sessionId);
    return (
      known !== undefined && known.installationId !== null && endedEras.has(known.installationId)
    );
  };
  // The era every row without a known session is written to. It is resolved
  // once, before either the session or its events are built, so a call and the
  // events describing it can never straddle a rollover — that would break the
  // scoped drill-down from one to the other. The row is then held shared for
  // the length of the write transaction below, so a session cannot be opened
  // inside an era whose close-out is underway: it would never be closed, and
  // its own `call_ended` would afterwards be refused as a straggler.
  let eraForNewRows = installationId;

  const eraFor = (sessionId: string | null | undefined): string =>
    (sessionId ? sessionEra.get(sessionId)?.installationId : null) ?? eraForNewRows;

  const buildRows = () =>
    events.map((event) => ({
      eventId: event.eventId,
      boothId: event.boothId,
      bootId: event.bootId,
      type: event.type,
      occurredAt: new Date(event.occurredAt),
      sessionId: event.sessionId ?? null,
      recordingId: event.recordingId ?? null,
      payload: event.payload ?? {},
      version: event.version ?? null,
      installationId: eraFor(event.sessionId),
    }));

  // 2. Atomically upsert sessions and insert events in a single transaction.
  //    If either step fails the entire batch is rolled back — no orphan
  //    sessions without source events.
  // Hold the era open for the length of this transaction. If the cached one has
  // ended, `runWithOpenEra` resolves — and if the booth is first past the
  // rollover, opens — another and retries: a booth write must never fail on
  // bookkeeping, but it must not land in a frozen era either.
  const inserted = await runWithOpenEra(installationId, async (tx, locked) => {
    eraForNewRows = locked;

    // Waiting for that lock takes time, and a concurrent batch can create one
    // of our sessions while we wait. Re-read the ones we did not already know
    // about, so their events follow the session rather than being filed under
    // the era this request happened to resolve.
    const unknown = referencedSessionIds.filter((id) => !sessionEra.has(id));
    if (unknown.length > 0) {
      const late = await tx.callSession.findMany({
        where: { id: { in: unknown } },
        select: { id: true, installationId: true, endedAt: true },
      });
      for (const row of late) sessionEra.set(row.id, row);
    }

    for (const init of sessionInits.values()) {
      if (!init.id || !init.boothId || !init.bootId) continue;
      // The rollover's close-out is terminal; a straggler event must not undo
      // it, or the ended era's summary stops matching its own drill-down.
      if (frozen(init.id)) continue;
      const startedAt = init.startedAt ?? new Date();
      const patch = {
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
        ...(init.version ? { version: init.version } : {}),
      };

      // The `frozen` check above reads before this transaction writes, so a
      // rollover committing in between would slip past it. The update is
      // therefore also conditional in the database: it only touches a session
      // whose era is still open (and which the rollover has not already
      // stamped), so a frozen era is safe however the timing falls.
      const updated = await tx.callSession.updateMany({
        where: {
          id: init.id,
          // Spelled out rather than a bare `NOT`: `outcome` is nullable, and in
          // SQL `NOT (outcome = '…')` is unknown — not true — for a NULL, which
          // would exclude every ordinary open session from this update.
          OR: [{ outcome: null }, { NOT: { outcome: ROLLOVER_OUTCOME } }],
          AND: [{ OR: [{ installationId: null }, { installation: { is: { endedAt: null } } }] }],
        },
        data: patch,
      });
      if (updated.count > 0) continue;

      // Nothing matched: either the session is frozen, or it does not exist
      // yet. An upsert with an empty update arm covers both without a
      // check-then-create race — a concurrent retry that won the create is a
      // no-op here rather than a unique violation rolling back the batch.
      await tx.callSession.upsert({
        where: { id: init.id },
        update: {},
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
          version: init.version ?? null,
          installationId: eraFor(init.id),
        },
      });
    }

    return tx.boothEvent.createMany({
      data: buildRows(),
      skipDuplicates: true,
    });
  });

  const accepted = inserted.count;
  const duplicates = events.length - accepted;

  // 3. Broadcast newly-inserted events to SSE subscribers only after the
  //    transaction has committed successfully.
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
          kind: "alert",
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
