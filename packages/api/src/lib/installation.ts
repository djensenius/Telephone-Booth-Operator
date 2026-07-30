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
  type Installation as InstallationDto,
  type InstallationSummary,
} from "@telephone-booth-operator/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { db } from "./db.js";
import { log } from "./logger.js";

// Name given to the installation created automatically when none exists.
const DEFAULT_INSTALLATION_NAME = "Installation 1";

// The active installation is read on essentially every write, but changes only
// when an admin starts or ends one. Cache the id and invalidate explicitly.
let activeIdCache: string | null = null;

export const invalidateActiveInstallationCache = (): void => {
  activeIdCache = null;
};

export const resetInstallationCacheForTests = (): void => {
  activeIdCache = null;
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

export const serializeInstallation = (row: InstallationRow): InstallationDto => ({
  id: row.id,
  name: row.name,
  notes: row.notes,
  location: row.location,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  endedById: row.endedById,
  // Stored as an opaque JSON column; it is written by `computeSummary` below
  // and only ever read back for display, so we pass it through as-is rather
  // than failing a whole list request on one malformed legacy row.
  summary: (row.summary as InstallationSummary | null) ?? null,
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
  if (activeIdCache) return activeIdCache;

  const existing = await findActiveInstallation();
  if (existing) {
    activeIdCache = existing.id;
    return existing.id;
  }

  try {
    const created = await db.installation.create({
      data: { name: await nextDefaultName() },
    });
    log.info({ installationId: created.id }, "created default installation");
    activeIdCache = created.id;
    return created.id;
  } catch {
    const raced = await findActiveInstallation();
    if (!raced) throw new Error("Unable to resolve an active installation.");
    activeIdCache = raced.id;
    return raced.id;
  }
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

// A resolved read scope. `null` means "span every installation" (the caller
// passed `installationId=all`); otherwise reads are filtered to one era.
export type InstallationScopeFilter = { installationId: string } | null;

// Turn the raw `installationId` query param into a Prisma `where` fragment.
//
//   undefined / ""  → the active installation (the default; this is what makes
//                     stats read "fresh" immediately after a rollover)
//   "all"           → no filter, i.e. the pre-installations behaviour
//   <uuid>          → that specific installation
export const resolveInstallationScope = async (
  raw: string | undefined,
): Promise<InstallationScopeFilter> => {
  if (raw === INSTALLATION_SCOPE_ALL) return null;
  if (raw && raw.length > 0) return { installationId: raw };
  return { installationId: await requireActiveInstallation() };
};

// Convenience for spreading into a Prisma `where` object.
export const scopeWhere = (scope: InstallationScopeFilter): { installationId?: string } =>
  scope ? { installationId: scope.installationId } : {};

// Cache-key fragment so scoped stats responses don't bleed across eras.
export const scopeCacheKey = (scope: InstallationScopeFilter): string =>
  scope ? scope.installationId : INSTALLATION_SCOPE_ALL;

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
