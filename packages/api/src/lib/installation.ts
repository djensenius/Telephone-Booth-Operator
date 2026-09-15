// Installations — a named era of the booth. Every booth write is tagged with
// the currently active installation so that "clearing everything" for a fresh
// run is a scope change rather than a delete, and past runs stay browsable.
//
// At most one row has `endedAt IS NULL` at a time. That invariant is enforced
// in Postgres by the `Installation_single_active_idx` partial unique index, so
// a race between two concurrent "start" calls fails loudly at the database
// rather than silently producing two active eras.

import {
  INSTALLATION_SCOPE_ALL,
  InstallationSummarySchema,
  type Installation as InstallationDto,
  type InstallationSummary,
  type InstallationState,
} from "@telephone-booth-operator/shared";
import { HTTPException } from "hono/http-exception";
import type { Prisma } from "../generated/prisma/client.js";
import { db } from "./db.js";
import {
  emptyInteractionBreakdown,
  summarizeInteractionBreakdown,
} from "./interaction-analytics.js";

// Suggested name for an operator's first installation.
const DEFAULT_INSTALLATION_NAME = "Installation 1";

type InstallationRow = {
  id: string;
  name: string;
  notes: string | null;
  location: string | null;
  defaultTranscriptionLanguage: string | null;
  startedAt: Date;
  endedAt: Date | null;
  endedById: string | null;
  summary: unknown;
  createdAt: Date;
};

export const parseInstallationSummary = (raw: unknown): InstallationSummary | null => {
  if (raw === null || raw === undefined) return null;
  // Summaries frozen before claimed processing used `messages` for every
  // landed recording. New summaries reserve it for the approved/playable
  // subset and add `allRecordings` plus `byStatus`. Presence of the new field
  // is the persisted format marker, so historical eras remain truthful rather
  // than silently rendering their total as a playable count.
  let normalized = raw;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    normalized = {
      ...record,
      ...(!("allRecordings" in record)
        ? {
            allRecordings: record["messages"],
            messages: record["messagesApproved"],
          }
        : {}),
      ...(!("interactions" in record) ? { interactions: record["calls"] } : {}),
      ...(!("interactionBreakdown" in record)
        ? { interactionBreakdown: emptyInteractionBreakdown() }
        : {}),
    };
  }
  const parsed = InstallationSummarySchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
};

export const serializeInstallation = (row: InstallationRow): InstallationDto => ({
  id: row.id,
  name: row.name,
  notes: row.notes,
  location: row.location,
  defaultTranscriptionLanguage: row.defaultTranscriptionLanguage,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  endedById: row.endedById,
  // Stored as an opaque JSON column, and an imported archive can carry anything
  // at all in it. Parse rather than cast: one malformed row should render as a
  // summary-less era, not make the whole list fail the client's own schema.
  summary: parseInstallationSummary(row.summary),
  createdAt: row.createdAt.toISOString(),
  isActive: row.endedAt === null,
});

export const findActiveInstallation = async (): Promise<InstallationRow | null> =>
  db.installation.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });

export const getInstallationState = async (): Promise<InstallationState> =>
  (await findActiveInstallation()) ? "active" : "between_exhibitions";

// A fresh database read makes an intentional stop visible on every replica.
// Writes must still hold the era lock to serialize with a concurrent end.
export const requireActiveInstallation = async (): Promise<string> => {
  const existing = await findActiveInstallation();
  if (!existing) throw new NoOpenEraError();
  return existing.id;
};

// Whether an era has any booth activity recorded against it. An era with none
// is bookkeeping only: it can be adopted and renamed, or discarded outright.
export const installationHasActivity = async (
  installationId: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<boolean> => {
  const where = { installationId };
  const [calls, messages, events, snapshots] = await Promise.all([
    client.callSession.count({ where }),
    client.message.count({ where }),
    client.boothEvent.count({ where }),
    client.boothStatusSnapshot.count({ where }),
  ]);
  return calls + messages + events + snapshots > 0;
};

// "Installation 1", "Installation 2", … based on how many eras exist already.
const nextDefaultName = async (): Promise<string> => {
  const count = await db.installation.count();
  return count === 0 ? DEFAULT_INSTALLATION_NAME : `Installation ${count + 1}`;
};

export const nextInstallationName = nextDefaultName;

// -----------------------------------------------------------------------------
// Read scoping
// -----------------------------------------------------------------------------

// A resolved read scope:
//   { kind: "one" }  → one era
//   { kind: "all" }  → span every installation (`installationId=all`)
//   { kind: "none" } → no era is open, so there is nothing in the default scope
export type InstallationScopeFilter =
  | { kind: "one"; installationId: string }
  | { kind: "all" }
  | { kind: "none" };

// Turn the raw `installationId` query param into a Prisma `where` fragment.
//
//   undefined / ""  → the active installation (the default; this is what makes
//                     stats read "fresh" immediately after a rollover)
//   "all"           → no filter, i.e. the pre-installations behaviour
//   <uuid>          → that specific installation
//
// Reads never *create* an installation. Between an admin ending an era and
// explicitly starting the next there is no active one; the answer is an empty
// result rather than a new era conjured up by someone loading a stats page.
export const resolveInstallationScope = async (
  raw: string | undefined,
): Promise<InstallationScopeFilter> => {
  if (raw === INSTALLATION_SCOPE_ALL) return { kind: "all" };
  if (raw && raw.length > 0) return { kind: "one", installationId: raw };
  const active = await findActiveInstallation();
  return active ? { kind: "one", installationId: active.id } : { kind: "none" };
};

// A `where` fragment produced by `scopeWhere`, ready to spread into a Prisma
// filter. `{ in: [] }` is how "match nothing" is expressed without inventing a
// sentinel id.
export type InstallationScopeWhere = { installationId?: string | { in: string[] } };

// Convenience for spreading into a Prisma `where` object.
export const scopeWhere = (scope: InstallationScopeFilter): InstallationScopeWhere => {
  if (scope.kind === "all") return {};
  if (scope.kind === "none") return { installationId: { in: [] } };
  return { installationId: scope.installationId };
};

// Cache-key fragment so scoped stats responses don't bleed across eras.
export const scopeCacheKey = (scope: InstallationScopeFilter): string => {
  if (scope.kind === "all") return INSTALLATION_SCOPE_ALL;
  if (scope.kind === "none") return "none";
  return scope.installationId;
};

// -----------------------------------------------------------------------------
// Summary counters, frozen when an installation ends
// -----------------------------------------------------------------------------

// The subset of the Prisma client `computeInstallationSummary` needs. Declared
// as the transaction client type so it can run either standalone or inside the
// rollover transaction.
type SummaryClient = Pick<
  Prisma.TransactionClient,
  "message" | "callSession" | "question" | "boothEvent"
>;

// Compute the counters frozen onto `Installation.summary` at end time.
// Accepts a client so it can run inside the rollover transaction.
export const computeInstallationSummary = async (
  client: SummaryClient,
  installationId: string,
): Promise<InstallationSummary> => {
  const where = { installationId };
  // An `uploading` row is a recording in flight, not a message: the close-out
  // deliberately leaves it alone and `/messages/:id/complete` files it into
  // whichever era is open when it lands. Counting it here would freeze a total
  // this era's own drill-down cannot account for.
  const landedMessages = { ...where, status: { not: "uploading" as const } };

  const [
    calls,
    sessions,
    actionEvents,
    messages,
    messagesApproved,
    messagesRejected,
    statusRows,
    questions,
    events,
    durations,
    firstEvent,
    lastEvent,
  ] = await Promise.all([
    client.callSession.count({ where }),
    client.callSession.findMany({
      where,
    }) as unknown as Promise<
      Array<{
        startedAt: Date;
        endedAt: Date | null;
        outcome: string | null;
        durationMs: number | null;
        digitsDialed: string | null;
      }>
    >,
    client.boothEvent.findMany({
      where: { ...where, type: { in: ["digit_dialed", "state_transition"] } },
    }) as unknown as Promise<Array<{ type: string; payload: unknown }>>,
    client.message.count({ where: landedMessages }),
    client.message.count({ where: { ...where, status: "approved" } }),
    client.message.count({ where: { ...where, status: "rejected" } }),
    client.message.findMany({
      where: landedMessages,
      select: { status: true },
    }),
    client.question.count({ where }),
    client.boothEvent.count({ where }),
    client.message.findMany({
      where: landedMessages,
      select: { audio: { select: { durationMs: true } } },
    }),
    client.boothEvent.findFirst({
      where,
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    client.boothEvent.findFirst({
      where,
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
  ]);

  const recordedMs = durations.reduce((total, row) => total + (row.audio?.durationMs ?? 0), 0);
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  const interactionBreakdown = summarizeInteractionBreakdown(sessions, actionEvents);

  return {
    calls,
    interactions: calls,
    interactionBreakdown,
    messages: messagesApproved,
    allRecordings: messages,
    byStatus,
    messagesApproved,
    messagesRejected,
    questions,
    events,
    recordedMs,
    firstActivityAt: firstEvent ? firstEvent.occurredAt.toISOString() : null,
    lastActivityAt: lastEvent ? lastEvent.occurredAt.toISOString() : null,
  };
};

// -----------------------------------------------------------------------------
// Rollover close-out
// -----------------------------------------------------------------------------

// `CallSession.outcome` written to sessions the booth never ended itself.
export const ROLLOVER_OUTCOME = "installation_ended";

// Stamped on messages the close-out drains from the queue, so a reader can tell
// the rollover's bookkeeping apart from a moderation decision an operator made.
export const ROLLOVER_MESSAGE_NOTE = "Closed out when the installation ended.";

// Bring an era to a consistent terminal state: no session left open, no message
// left in the moderation queue, no question left live, and the counters frozen.
//
// Shared by the `POST /:id/end` route and the restore path, which has to close
// out whatever era the target instance had open. Doing it in one place keeps a
// restored instance from inheriting an era that is "ended" in name only, with
// pending messages still feeding the moderation badge.
// Postgres MVCC means a reader cannot see a rollover that has run its close-out
// but not yet committed, so no amount of re-reading makes a write safe on its
// own. These two helpers put the era row itself between them: a writer holds it
// shared for the length of its transaction, the rollover takes it exclusively,
// and the two therefore queue rather than overlap. Shared locks do not conflict
// with each other, so concurrent writes are unaffected except in the moment an
// era is actually ending.
export const lockInstallationForWrite = async (
  tx: Prisma.TransactionClient,
  installationId: string,
): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ endedAt: Date | null }[]>`
    SELECT "endedAt" FROM "Installation" WHERE "id" = ${installationId}::uuid FOR SHARE
  `;
  return rows.length > 0 && rows[0]?.endedAt === null;
};

// Take an era exclusively, excluding the booth writers that hold it shared.
// Used where a decision depends on the era's *contents* rather than merely on
// its being open — adopting an empty era, for instance, has to know no booth
// write is about to land in it.
export const lockInstallationExclusively = async (
  tx: Prisma.TransactionClient,
  installationId: string,
): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ endedAt: Date | null }[]>`
    SELECT "endedAt" FROM "Installation" WHERE "id" = ${installationId}::uuid FOR UPDATE
  `;
  return rows.length > 0 && rows[0]?.endedAt === null;
};

// How many times a write will chase a rollover before giving up. Each pass has
// to lose to a *different* rollover, so a third is already generous.
export const ERA_LOCK_ATTEMPTS = 3;

// Resolve an era that is open and hold it that way for the rest of `tx`.
// Returns null when no era is open, or when eras keep ending underneath the
// caller — in practice something is wrong rather than merely busy.
//
// Every read here goes through `tx`. The callback already holds a pooled
// connection, so reaching for the global client to re-resolve a candidate
// would ask the pool for a second one while holding the first: enough
// concurrent writers arriving just after a rollover would take every
// connection and then wait on each other. Missing eras remain missing.
type InstallationLock = (tx: Prisma.TransactionClient, installationId: string) => Promise<boolean>;

const lockOpenInstallationWith = async (
  tx: Prisma.TransactionClient,
  lock: InstallationLock,
  preferred?: string,
): Promise<string | null> => {
  const openEra = async (): Promise<string | null> => {
    const row = await tx.installation.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    return row?.id ?? null;
  };

  let candidate = preferred ?? (await openEra());
  for (let attempt = 0; attempt < ERA_LOCK_ATTEMPTS && candidate !== null; attempt += 1) {
    if (await lock(tx, candidate)) return candidate;
    const next = await openEra();
    if (next === candidate) return null;
    candidate = next;
  }
  return null;
};

export const lockOpenInstallation = (
  tx: Prisma.TransactionClient,
  preferred?: string,
): Promise<string | null> => lockOpenInstallationWith(tx, lockInstallationForWrite, preferred);

// Question selection mutates a shared ticket bag. An exclusive era lock makes
// the draw and its persisted consumption one serial operation across replicas.
export const lockOpenInstallationExclusively = (
  tx: Prisma.TransactionClient,
): Promise<string | null> => lockOpenInstallationWith(tx, lockInstallationExclusively);

export class NoOpenEraError extends HTTPException {
  constructor() {
    super(409, {
      message: "installation_inactive",
      res: Response.json(
        {
          type: "about:blank",
          title: "Between exhibitions",
          status: 409,
          detail:
            "An operator must start an installation before booth activity can resume. Retain pending uploads and retry after it starts.",
          error: "installation_inactive",
        },
        { status: 409, headers: { "content-type": "application/problem+json" } },
      ),
    });
    this.name = "NoOpenEraError";
  }
}

// Run a write inside a transaction that holds an open era for its duration.
//
// The lock resolver follows a concurrent manual rollover, but never opens an
// era itself. Intentional downtime is a typed conflict, not an implicit start.
export const runWithOpenEra = async <T>(
  preferred: string | undefined,
  write: (tx: Prisma.TransactionClient, era: string) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> => {
  return db.$transaction(async (tx) => {
    const era = await lockOpenInstallation(tx, preferred);
    if (era === null) throw new NoOpenEraError();
    return write(tx, era);
  }, options);
};

export const closeOutInstallation = async (
  tx: Prisma.TransactionClient,
  installationId: string,
  endedAt: Date,
): Promise<InstallationSummary> => {
  // Take the era row exclusively before touching anything it owns. Writers hold
  // it shared, so this waits for the ones already in flight and makes any that
  // arrive mid-close-out wait for it — closing the window where a write commits
  // into an era whose draining was underway but invisible.
  await tx.$queryRaw`SELECT "id" FROM "Installation" WHERE "id" = ${installationId}::uuid FOR UPDATE`;

  // Close sessions the booth never ended (power cut, crash mid-call).
  await tx.callSession.updateMany({
    where: { installationId, endedAt: null },
    data: { endedAt, outcome: ROLLOVER_OUTCOME },
  });

  // Empty the moderation queue so the next era starts clean. The audio and
  // transcripts are untouched and stay visible under this installation's
  // scope; only the queue-visible statuses move to a terminal one.
  //
  // `uploading` is deliberately left alone: a caller can be midway through
  // sending a recording when the operator ends the era, and rejecting the row
  // here would strand the finished audio in a terminal state nobody reviews.
  // `POST /messages/:id/complete` re-files such a straggler into the open era,
  // the same way a recording started after the rollover is handled.
  await tx.message.updateMany({
    where: { installationId, status: { in: ["received", "pending"] } },
    data: {
      status: "rejected",
      notes: ROLLOVER_MESSAGE_NOTE,
      decidedAt: endedAt,
    },
  });

  // Retire this era's live questions. Drafts are left alone so they stay
  // distinguishable from questions that were actually in rotation.
  await tx.question.updateMany({
    where: { installationId, status: "active" },
    data: { status: "archived", retiredAt: endedAt },
  });

  // Computed last, so the frozen counters agree with what browsing this era
  // afterwards reports — in particular the messages just rejected above.
  return computeInstallationSummary(tx, installationId);
};
