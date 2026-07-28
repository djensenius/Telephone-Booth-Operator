import { zValidator } from "@hono/zod-validator";
import { StatusUpdateSchema } from "@telephone-booth-operator/shared";
import type { StatusUpdate } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { defaultStatus, serializeStatus } from "../lib/serializers.js";
import { requireOperatorOrApiToken, type AuthVariables } from "../lib/session.js";

const historyQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// On-hook reconciliation. The booth is a single-line phone, so when it reports
// `idle` nothing can be active — any still-open CallSession is provably stale
// (its `call_ended` event was produced but never delivered/persisted). Close
// those sessions so `inProgress` stats return to the true count. Marking the
// outcome `aborted` (rather than `recording_completed`) keeps completion-rate
// metrics honest. Scoped only by time for now because `BoothStatusSnapshot`
// has no `boothId`; safe for the single-booth installation (see ADR 0006).
//
// `durationMs` is left null: the real call ended at an unknown earlier time (its
// `call_ended` was never delivered), so `idleTime - startedAt` would be fiction.
// It would also overflow the `Int` column once a session has been open longer
// than ~24.9 days — precisely the long-lived rows this reconciliation targets.
//
// A single `updateMany` closes the whole (unbounded) stale backlog in one atomic
// statement. The `endedAt: null` predicate keeps the write conditional, so an
// authoritative `call_ended` persisted concurrently wins the race and is not
// overwritten by an `aborted` reconciliation. The `startedAt <= idleTime` guard
// avoids closing a newer session started after a delayed idle report.
async function reconcileStaleSessionsOnIdle(idleTime: Date): Promise<void> {
  await db.callSession.updateMany({
    where: { endedAt: null, startedAt: { lte: idleTime } },
    data: {
      endedAt: idleTime,
      outcome: "aborted",
      durationMs: null,
    },
  });
}

export const statusRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

// Two reports describe the same booth status when every observable field
// matches. `updatedAt` is deliberately excluded — it is what changes on every
// heartbeat, and collapsing is exactly the act of folding a newer timestamp
// into an unchanged status.
function isRepeatOf(
  snapshot: {
    readonly state: string;
    readonly currentQuestionId: string | null;
    readonly currentMessageId: string | null;
    readonly lastError: string | null;
    readonly runtimeMode: string | null;
  },
  update: StatusUpdate,
): boolean {
  return (
    snapshot.state === update.state &&
    snapshot.currentQuestionId === (update.currentQuestionId ?? null) &&
    snapshot.currentMessageId === (update.currentMessageId ?? null) &&
    snapshot.lastError === (update.lastError ?? null) &&
    snapshot.runtimeMode === (update.runtimeMode ?? null)
  );
}

/**
 * Where a collapsed run starts once `reportedAt` is folded into it.
 *
 * A report that reaches us late can predate the run's `firstSeenAt`, and the
 * window widens to cover it. It must not widen past the preceding snapshot,
 * though: a delayed report from an *earlier* run of the same status would
 * otherwise make the current run appear to have started before the transition
 * that ended that earlier run.
 */
function widenedStart(
  latest: { firstSeenAt: Date },
  previous: { updatedAt: Date } | undefined,
  reportedAt: Date,
): Date {
  if (reportedAt >= latest.firstSeenAt) return latest.firstSeenAt;
  if (previous && reportedAt <= previous.updatedAt) return latest.firstSeenAt;
  return reportedAt;
}

statusRouter.get("/", requireOperatorOrApiToken(), async (c) => {
  // Authenticated read of the latest booth snapshot. Operator clients use a
  // session cookie or operator bearer; the booth/phone client uses its API token.
  const latest = await db.boothStatusSnapshot.findFirst({ orderBy: { updatedAt: "desc" } });
  return c.json(latest ? serializeStatus(latest) : defaultStatus());
});

statusRouter.put("/", requireApiToken(), zValidator("json", StatusUpdateSchema), async (c) => {
  const update = c.req.valid("json");
  const reportedAt = update.updatedAt ? new Date(update.updatedAt) : new Date();
  const [latest, previous] = await db.boothStatusSnapshot.findMany({
    orderBy: { updatedAt: "desc" },
    take: 2,
  });
  // Collapse heartbeats. The booth re-pushes its current status every few
  // seconds so the operator never shows stale state, which meant an idle booth
  // wrote one snapshot row per beat and buried the genuine transitions under a
  // page of identical `idle` rows. When the report is identical to the newest
  // snapshot we fold it into that row instead: widen the [firstSeenAt,
  // updatedAt] window and count the beat. Distinct fields (a real transition,
  // a new error, a runtime-mode change) still create a new row, so the history
  // reads as one row per booth state.
  //
  // Concurrent PUTs can interleave between the read and the write; the worst
  // case is a lost increment or a duplicate row, both harmless for a display
  // counter on a single-line booth.
  const snapshot =
    latest && isRepeatOf(latest, update)
      ? await db.boothStatusSnapshot.update({
          where: { id: latest.id },
          data: {
            firstSeenAt: widenedStart(latest, previous, reportedAt),
            updatedAt: reportedAt > latest.updatedAt ? reportedAt : latest.updatedAt,
            repeatCount: { increment: 1 },
          },
        })
      : await db.boothStatusSnapshot.create({
          data: {
            state: update.state,
            currentQuestionId: update.currentQuestionId ?? null,
            currentMessageId: update.currentMessageId ?? null,
            lastError: update.lastError ?? null,
            runtimeMode: update.runtimeMode ?? null,
            firstSeenAt: reportedAt,
            updatedAt: reportedAt,
          },
        });
  if (update.state === "idle") {
    await reconcileStaleSessionsOnIdle(snapshot.updatedAt);
  }
  wsBroadcaster.broadcast({ kind: "status", status: serializeStatus(snapshot) });
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
