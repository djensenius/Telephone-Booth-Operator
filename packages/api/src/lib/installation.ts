// Installations — a named era of the booth. Every booth write is tagged with
// the currently active installation so that "clearing everything" for a fresh
// run is a scope change rather than a delete, and past runs stay browsable.
//
// Exactly one row has `endedAt IS NULL` at a time. That invariant is enforced
// in Postgres by the `Installation_single_active_idx` partial unique index, so
// a race between two concurrent "start" calls fails loudly at the database
// rather than silently producing two active eras.

import {
  INSTALLATION_SCOPE_ALL,
  InstallationSummarySchema,
  type Installation as InstallationDto,
  type InstallationSummary,
} from "@telephone-booth-operator/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { db } from "./db.js";
import { log } from "./logger.js";

// Name given to the installation created automatically when none exists.
const DEFAULT_INSTALLATION_NAME = "Installation 1";

// The active installation is read on essentially every write, but changes only
// when an admin starts or ends one. Cache the id to keep that off the hot path.
//
// The cache is invalidated explicitly on start/end, but that only reaches the
// replica that served the admin request — the documented Azure deployment runs
// several (see docs/azure-deployment.md). A short TTL therefore bounds how long
// any other replica can keep stamping rows with an ended era, without putting a
// query back on every booth write.
const ACTIVE_CACHE_TTL_MS = 5_000;
let activeIdCache: string | null = null;
let activeIdCacheExpiresAt = 0;

const readActiveIdCache = (): string | null =>
  activeIdCache && Date.now() < activeIdCacheExpiresAt ? activeIdCache : null;

const writeActiveIdCache = (id: string): string => {
  activeIdCache = id;
  activeIdCacheExpiresAt = Date.now() + ACTIVE_CACHE_TTL_MS;
  return id;
};

export const invalidateActiveInstallationCache = (): void => {
  activeIdCache = null;
  activeIdCacheExpiresAt = 0;
};

export const resetInstallationCacheForTests = (): void => {
  invalidateActiveInstallationCache();
};

type InstallationRow = {
  id: string;
  name: string;
  notes: string | null;
  location: string | null;
  startedAt: Date;
  endedAt: Date | null;
  endedById: string | null;
  summary: unknown;
  createdAt: Date;
};

const parseSummary = (raw: unknown): InstallationSummary | null => {
  if (raw === null || raw === undefined) return null;
  const parsed = InstallationSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const serializeInstallation = (row: InstallationRow): InstallationDto => ({
  id: row.id,
  name: row.name,
  notes: row.notes,
  location: row.location,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  endedById: row.endedById,
  // Stored as an opaque JSON column, and an imported archive can carry anything
  // at all in it. Parse rather than cast: one malformed row should render as a
  // summary-less era, not make the whole list fail the client's own schema.
  summary: parseSummary(row.summary),
  createdAt: row.createdAt.toISOString(),
  isActive: row.endedAt === null,
});

export const findActiveInstallation = async (): Promise<InstallationRow | null> =>
  db.installation.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });

// Resolve the installation that new rows should be tagged with.
//
// A booth must never fail to record a call because of an admin bookkeeping
// gap, so when no active installation exists (a brand-new database, or one
// where the last era was ended and no new one started yet) we create a default
// one rather than throwing. The unique index makes the create racy-safe: if a
// concurrent request wins, we re-read and use theirs.
export const requireActiveInstallation = async (): Promise<string> => {
  const cached = readActiveIdCache();
  if (cached) return cached;

  const existing = await findActiveInstallation();
  if (existing) return writeActiveIdCache(existing.id);

  try {
    const created = await db.installation.create({
      data: { name: await nextDefaultName() },
    });
    log.info({ installationId: created.id }, "created default installation");
    return writeActiveIdCache(created.id);
  } catch {
    const raced = await findActiveInstallation();
    if (!raced) throw new Error("Unable to resolve an active installation.");
    return writeActiveIdCache(raced.id);
  }
};

// Resolve an installation that is *provably* open right now.
//
// `requireActiveInstallation` answers from a per-replica cache with a short
// TTL, which is the right trade for the hot write path: a row landing in an era
// that ended microseconds ago is the accepted rollover race. It is the wrong
// answer when the caller already knows it is dealing with a straggler — filing
// a re-homed row into an era that has also ended would put it somewhere nobody
// is looking, and could create a session that can never be closed. Those paths
// pay for a fresh read instead.
export const requireOpenInstallation = async (): Promise<string> => {
  invalidateActiveInstallationCache();
  return requireActiveInstallation();
};

// Whether an era has any booth activity recorded against it. An era with none
// is bookkeeping only: it can be adopted and renamed, or discarded outright.
export const installationHasActivity = async (installationId: string): Promise<boolean> => {
  const where = { installationId };
  const [calls, messages, events, snapshots] = await Promise.all([
    db.callSession.count({ where }),
    db.message.count({ where }),
    db.boothEvent.count({ where }),
    db.boothStatusSnapshot.count({ where }),
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
// Reads never *create* an installation. Between an admin ending an era and the
// next booth write there is no active one, and the honest answer is an empty
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

  const [
    calls,
    messages,
    messagesApproved,
    messagesRejected,
    questions,
    events,
    durations,
    firstEvent,
    lastEvent,
  ] = await Promise.all([
    client.callSession.count({ where }),
    client.message.count({ where }),
    client.message.count({ where: { ...where, status: "approved" } }),
    client.message.count({ where: { ...where, status: "rejected" } }),
    client.question.count({ where }),
    client.boothEvent.count({ where }),
    client.message.findMany({ where, select: { audio: { select: { durationMs: true } } } }),
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

  return {
    calls,
    messages,
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

// Bring an era to a consistent terminal state: no session left open, no message
// left in the moderation queue, no question left live, and the counters frozen.
//
// Shared by the `POST /:id/end` route and the restore path, which has to close
// out whatever era the target instance had open. Doing it in one place keeps a
// restored instance from inheriting an era that is "ended" in name only, with
// pending messages still feeding the moderation badge.
export const closeOutInstallation = async (
  tx: Prisma.TransactionClient,
  installationId: string,
  endedAt: Date,
): Promise<InstallationSummary> => {
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
      notes: "Closed out when the installation ended.",
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
