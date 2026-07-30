// Audit trail for write actions (issue #123).
//
// Every mutating request to the operator API is recorded with **who** did it,
// **from where**, and **when**. The mechanism is a single middleware rather
// than per-handler calls so a new write endpoint is audited by default and
// cannot silently escape the trail. Handlers then enrich the row with a stable
// action name, the target they touched, and any action-specific metadata via
// `recordAudit()`.
//
// Design notes:
//   • Rejected writes are recorded too (`statusCode` tells them apart). A 403
//     on an approval endpoint is precisely what an audit trail is for.
//   • The row is written *after* the handler, so it reflects the real outcome.
//   • An audit failure never fails the request — it is logged at error level
//     instead. Losing an approval because the audit insert hiccuped would be a
//     worse outcome than a gap in the trail, which the log surfaces loudly.
//   • Booth telemetry heartbeats (`PUT /v1/status`, `PUT /v1/system`,
//     `POST /v1/events`) are excluded by default: they arrive every few
//     seconds, are already persisted with their own timestamps, and are not
//     operator actions. Set `AUDIT_LOG_TELEMETRY=true` to include them.
//
// See docs/audit-log.md.

import type { ApiToken, OperatorUser, Prisma } from "../generated/prisma/client.js";
import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "./client-ip.js";
import { db } from "./db.js";
import { log } from "./logger.js";

export type AuditActorType = "operator" | "apiToken" | "anonymous" | "system";

// Mutable per-request draft. Handlers refine it through `recordAudit()`; the
// middleware persists whatever it holds once the response is ready.
export type AuditDraft = {
  action?: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  // Overrides for flows where the actor is not on the context yet (the OIDC
  // callback establishes the session *inside* the handler, for example).
  actorType?: AuditActorType;
  actorUserId?: string | null;
  actorLabel?: string | null;
  skip?: boolean;
};

export type AuditVariables = {
  audit: AuditDraft;
};

export type AuditDetail = {
  action?: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  actorType?: AuditActorType;
  actorUserId?: string | null;
  actorLabel?: string | null;
};

const AUDIT_KEY = "audit";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const MAX_ACTION_LENGTH = 128;
const MAX_PATH_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_LABEL_LENGTH = 320;
const MAX_METADATA_STRING_LENGTH = 2000;

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const warnedFlags = new Set<string>();

const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

// A typo must never quietly change the trail's behaviour, so only a value we
// recognize moves the flag off its default; anything else keeps the default
// and says so.
const flag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  // One misconfiguration must not flood the logs at request rate.
  const seen = `${name}=${raw}`;
  if (!warnedFlags.has(seen)) {
    warnedFlags.add(seen);
    log.warn({ event: "audit.invalid_flag", flag: name, value: raw, using: fallback });
  }
  return fallback;
};

export const auditEnabled = (): boolean => flag("AUDIT_LOG_ENABLED", true);
const auditTelemetry = (): boolean => flag("AUDIT_LOG_TELEMETRY", false);

// High-frequency booth telemetry. Matched on the *route pattern* so a path
// parameter can never be used to dodge the check.
const TELEMETRY_ROUTES: ReadonlySet<string> = new Set([
  "PUT /v1/status",
  "PUT /v1/system",
  "POST /v1/events",
]);

const normalizeRoute = (method: string, routePath: string): string =>
  `${method.toUpperCase()} ${routePath.replace(/\/+$/, "") || "/"}`;

export const isTelemetryWrite = (method: string, routePath: string): boolean =>
  TELEMETRY_ROUTES.has(normalizeRoute(method, routePath));

const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_KEYS = 32;
// The marker lists key names, so they need their own (much smaller) bound —
// a single megabyte-long key would otherwise defeat the size cap it replaces.
const MAX_METADATA_MARKER_KEY_LENGTH = 120;
const MAX_METADATA_ITEMS = 20;
const MAX_METADATA_BYTES = 8000;

// Audit rows are long-lived and queryable, so metadata is bounded rather than
// trusted: strings are truncated, structures are capped in depth and width,
// and anything that still serializes too large is replaced with a marker.
const sanitizeValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return truncate(value, MAX_METADATA_STRING_LENGTH);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_METADATA_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_METADATA_ITEMS) items.push("[truncated]");
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .slice(0, MAX_METADATA_KEYS);
    return Object.fromEntries(
      entries.map(([key, nested]) => [key, sanitizeValue(nested, depth + 1)]),
    );
  }
  // Functions, symbols and bigints have no place in an audit row.
  return "[unsupported]";
};

/** Exported for tests: the bound is a contract, not an implementation detail. */
export const sanitizeMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null => {
  if (!metadata) return null;
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  const sanitized = Object.fromEntries(
    entries
      .slice(0, MAX_METADATA_KEYS)
      .map(([key, value]) => [key, sanitizeValue(value, 1)] as const),
  );
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized) ?? "";
  } catch {
    // A cycle or a throwing `toJSON` would otherwise fail the insert.
    return { error: "unserializable_metadata" };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    return {
      error: "metadata_too_large",
      keys: Object.keys(sanitized)
        .slice(0, MAX_METADATA_KEYS)
        .map((key) => truncate(key, MAX_METADATA_MARKER_KEY_LENGTH)),
    };
  }
  return sanitized;
};

// Unauthenticated writes to real endpoints are recorded because a denied
// attempt is evidence, but an anonymous caller must not be able to turn a
// loop into unbounded rows. Each address gets a small quota per window; the
// overflow is counted and reported on the next recorded row for that address,
// so the evidence survives without the volume.
const ANON_WINDOW_MS = 60_000;
const ANON_MAX_TRACKED_IPS = 5000;

const DEFAULT_ANON_QUOTA = 20;

// Parsed strictly: `0` disables the cap, so a typo that parses as a numeric
// prefix must not be read as "unlimited".
const anonQuota = (): number => {
  const trimmed = process.env.AUDIT_LOG_ANON_LIMIT_PER_MINUTE?.trim();
  if (!trimmed) return DEFAULT_ANON_QUOTA;
  const raw = Number(trimmed);
  if (!Number.isSafeInteger(raw) || raw < 0) {
    const seen = `AUDIT_LOG_ANON_LIMIT_PER_MINUTE=${trimmed}`;
    if (!warnedFlags.has(seen)) {
      warnedFlags.add(seen);
      log.warn({
        event: "audit.invalid_flag",
        flag: "AUDIT_LOG_ANON_LIMIT_PER_MINUTE",
        value: trimmed,
        using: DEFAULT_ANON_QUOTA,
      });
    }
    return DEFAULT_ANON_QUOTA;
  }
  return raw;
};

type AnonBucket = { windowStart: number; recorded: number; suppressed: number };

const anonBuckets = new Map<string, AnonBucket>();

/** Test seam: the quota is process-wide state. */
export const resetAuditThrottleForTests = (): void => {
  anonBuckets.clear();
  warnedFlags.clear();
};

const dropExpired = (now: number): void => {
  for (const [key, bucket] of anonBuckets) {
    if (now - bucket.windowStart >= ANON_WINDOW_MS) anonBuckets.delete(key);
  }
};

/**
 * Returns null when the row should be dropped, otherwise the number of rows
 * suppressed for this address since it was last recorded. Exported so the
 * hand-written auth events are bounded the same way the middleware is.
 */
export const anonAllowance = (ip: string | null): number | null => {
  const quota = anonQuota();
  if (quota === 0) return 0;
  const key = ip ?? "unknown";
  const now = Date.now();
  let bucket = anonBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= ANON_WINDOW_MS) {
    if (!bucket) {
      if (anonBuckets.size >= ANON_MAX_TRACKED_IPS) dropExpired(now);
      // Still full: the table is under a distributed flood, so stop adding.
      if (anonBuckets.size >= ANON_MAX_TRACKED_IPS) return null;
    }
    bucket = { windowStart: now, recorded: 0, suppressed: bucket?.suppressed ?? 0 };
    anonBuckets.set(key, bucket);
  }
  if (bucket.recorded >= quota) {
    bucket.suppressed += 1;
    return null;
  }
  bucket.recorded += 1;
  const suppressed = bucket.suppressed;
  bucket.suppressed = 0;
  return suppressed;
};

export type AuditEntryInput = {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorTokenId?: string | null;
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
  method: string;
  path: string;
  statusCode: number;
  metadata?: Record<string, unknown> | null;
};

// Persist one audit row. Never throws: a broken audit sink must not take the
// API down with it, but it must be loud in the logs.
const MAX_TARGET_TYPE_LENGTH = 64;
const MAX_TARGET_ID_LENGTH = 255;
const MAX_METHOD_LENGTH = 10;
const MAX_IP_LENGTH = 45;

const boundString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value ? truncate(value, max) : null;

/**
 * The size limits an audit row must satisfy, in one place: live writes and
 * rows coming back through a restore are both operator-visible history, so
 * neither may exceed what the list endpoint and console can render.
 */
export type BoundedAuditRow = {
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  method: string;
  path: string;
  metadata: Record<string, unknown> | null;
};

export const boundAuditFields = <T extends Record<string, unknown>>(
  row: T,
): T & BoundedAuditRow => ({
  ...row,
  action: boundString(row.action, MAX_ACTION_LENGTH) ?? "unknown",
  targetType: boundString(row.targetType, MAX_TARGET_TYPE_LENGTH),
  targetId: boundString(row.targetId, MAX_TARGET_ID_LENGTH),
  actorLabel: boundString(row.actorLabel, MAX_LABEL_LENGTH) ?? "unknown",
  ip: boundString(row.ip, MAX_IP_LENGTH),
  userAgent: boundString(row.userAgent, MAX_USER_AGENT_LENGTH),
  method: boundString(row.method, MAX_METHOD_LENGTH) ?? "UNKNOWN",
  path: boundString(row.path, MAX_PATH_LENGTH) ?? "/",
  metadata: sanitizeMetadata(
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : undefined,
  ),
});

export const writeAuditEntry = async (entry: AuditEntryInput): Promise<void> => {
  try {
    const bounded = boundAuditFields({
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      actorLabel: entry.actorLabel,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      method: entry.method,
      path: entry.path,
      metadata: entry.metadata ?? null,
    });
    await db.auditLog.create({
      data: {
        action: bounded.action,
        targetType: bounded.targetType,
        targetId: bounded.targetId,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        actorTokenId: entry.actorTokenId ?? null,
        actorLabel: bounded.actorLabel,
        ip: bounded.ip,
        userAgent: bounded.userAgent,
        method: bounded.method,
        path: bounded.path,
        statusCode: entry.statusCode,
        ...(bounded.metadata ? { metadata: bounded.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  } catch (error) {
    log.error(
      {
        event: "audit.write_failed",
        action: entry.action,
        reason: error instanceof Error ? error.message : "unknown",
      },
      "failed to write audit log entry",
    );
  }
};

// Enrich the current request's audit row. Safe to call repeatedly; later calls
// win per field and metadata is merged.
export const recordAudit = (c: Context, detail: AuditDetail): void => {
  const draft = c.get(AUDIT_KEY) as AuditDraft | undefined;
  if (!draft) return;
  if (detail.action !== undefined) draft.action = detail.action;
  if (detail.targetType !== undefined) draft.targetType = detail.targetType;
  if (detail.targetId !== undefined) draft.targetId = detail.targetId;
  if (detail.actorType !== undefined) draft.actorType = detail.actorType;
  if (detail.actorUserId !== undefined) draft.actorUserId = detail.actorUserId;
  if (detail.actorLabel !== undefined) draft.actorLabel = detail.actorLabel;
  if (detail.metadata) draft.metadata = { ...draft.metadata, ...detail.metadata };
};

// Opt a specific write out of the trail (used for idempotent no-ops that would
// otherwise flood the table). Prefer `recordAudit` with metadata over this.
export const skipAudit = (c: Context): void => {
  const draft = c.get(AUDIT_KEY) as AuditDraft | undefined;
  if (draft) draft.skip = true;
};

type ResolvedActor = {
  actorType: AuditActorType;
  actorUserId: string | null;
  actorTokenId: string | null;
  actorLabel: string;
};

const operatorLabel = (user: OperatorUser): string => user.email || user.name || user.id;

const resolveActor = (c: Context, draft: AuditDraft): ResolvedActor => {
  const user = c.get("user") as OperatorUser | undefined;
  if (user) {
    return {
      actorType: "operator",
      actorUserId: user.id,
      actorTokenId: null,
      actorLabel: operatorLabel(user),
    };
  }
  const token = c.get("apiToken") as ApiToken | undefined;
  if (token) {
    return {
      actorType: "apiToken",
      actorUserId: null,
      actorTokenId: token.id,
      actorLabel: `token:${token.name}`,
    };
  }
  // The handler may know the actor even when the middleware chain does not
  // (login completes inside the OIDC callback).
  if (draft.actorUserId || draft.actorLabel) {
    return {
      actorType: draft.actorType ?? "operator",
      actorUserId: draft.actorUserId ?? null,
      actorTokenId: null,
      actorLabel: draft.actorLabel ?? draft.actorUserId ?? "unknown",
    };
  }
  return {
    actorType: draft.actorType ?? "anonymous",
    actorUserId: null,
    actorTokenId: null,
    actorLabel: "anonymous",
  };
};

const isCatchAll = (pattern: string | undefined): boolean =>
  !pattern || pattern === "/*" || pattern === "*";

/**
 * Did the request reach a real handler, or only the mounted middleware?
 *
 * `matchedRoutes` is filled from the router match, so it answers this even
 * when an auth guard short-circuits the chain. A write to a path nobody
 * serves is a 404 against a name the caller invented, and recording those
 * would let anyone mint rows with paths of their choosing.
 */
const matchedAHandler = (c: Context): boolean =>
  c.req.matchedRoutes.some((route) => !route.path.endsWith("*"));

const routePattern = (c: Context): string => {
  // When a guard short-circuits, `routePath` is still the middleware's own
  // pattern, so the handler route is read from the match instead. Without
  // this a denied write collapses to `http.post /v1/*`, which no action
  // filter can tell apart.
  const matched = c.req.matchedRoutes.filter((route) => !route.path.endsWith("*"));
  const handler = matched[matched.length - 1]?.path;
  if (handler) return handler;
  const pattern = c.req.routePath;
  if (isCatchAll(pattern)) return new URL(c.req.url).pathname;
  return pattern;
};

const defaultAction = (method: string, pattern: string): string =>
  `http.${method.toLowerCase()} ${pattern}`;

/**
 * Records one audit row per mutating request. Mount once, as early as
 * possible, so it wraps authentication too (rejected writes are audited).
 */
export const auditWrites =
  (): MiddlewareHandler<{ Variables: AuditVariables }> => async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase()) || !auditEnabled()) {
      await next();
      return;
    }

    const draft: AuditDraft = {};
    c.set(AUDIT_KEY, draft);

    const persist = async (statusCode: number): Promise<void> => {
      if (draft.skip) return;
      if (!matchedAHandler(c)) return;
      const pattern = routePattern(c);
      // Telemetry is excluded for volume, not for secrecy: a heartbeat that
      // succeeded is noise, but one that was denied or malformed is exactly
      // the evidence this trail exists for, so only the quiet ones are
      // dropped.
      if (!auditTelemetry() && statusCode < 400 && isTelemetryWrite(c.req.method, pattern)) return;
      const actor = resolveActor(c, draft);
      const ip = clientIp(c);
      let metadata = draft.metadata;
      // Anything without a persisted actor is a caller the API refused to
      // recognize, whatever it called itself, so the quota covers all of
      // them: a token from the issuer must not buy unmetered rows.
      if (statusCode >= 400 && !actor.actorUserId && !actor.actorTokenId) {
        const suppressed = anonAllowance(ip);
        if (suppressed === null) return;
        if (suppressed > 0) metadata = { ...(metadata ?? {}), suppressedSince: suppressed };
      }
      await writeAuditEntry({
        action: draft.action ?? defaultAction(c.req.method, pattern),
        targetType: draft.targetType ?? null,
        targetId: draft.targetId ?? null,
        ...actor,
        ip,
        userAgent: c.req.header("user-agent") ?? null,
        method: c.req.method.toUpperCase(),
        path: new URL(c.req.url).pathname,
        statusCode,
        metadata: sanitizeMetadata(metadata),
      });
    };

    try {
      await next();
    } catch (error) {
      // Only a classification, never the message: provider and Prisma errors
      // can quote query values, and audit rows are long-lived and queryable.
      recordAudit(c, {
        metadata: { error: error instanceof Error ? error.name : "unhandled" },
      });
      await persist(500);
      throw error;
    }

    await persist(c.res.status);
  };
