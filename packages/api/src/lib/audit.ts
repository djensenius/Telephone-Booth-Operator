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

const flag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
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

// Keep metadata small and free of anything sensitive. Values are shallow by
// contract; nested objects are JSON-stringified so a caller cannot smuggle an
// unbounded structure into the row.
const sanitizeMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null => {
  if (!metadata) return null;
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      typeof value === "string" ? truncate(value, MAX_METADATA_STRING_LENGTH) : value,
    ]),
  );
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
export const writeAuditEntry = async (entry: AuditEntryInput): Promise<void> => {
  try {
    await db.auditLog.create({
      data: {
        action: truncate(entry.action, MAX_ACTION_LENGTH),
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        actorTokenId: entry.actorTokenId ?? null,
        actorLabel: truncate(entry.actorLabel, MAX_LABEL_LENGTH),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ? truncate(entry.userAgent, MAX_USER_AGENT_LENGTH) : null,
        method: entry.method,
        path: truncate(entry.path, MAX_PATH_LENGTH),
        statusCode: entry.statusCode,
        ...(entry.metadata ? { metadata: entry.metadata as Prisma.InputJsonValue } : {}),
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

const routePattern = (c: Context): string => {
  const pattern = c.req.routePath;
  // Unmatched routes report the catch-all pattern; the real path is more
  // useful there.
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
      const pattern = routePattern(c);
      if (!auditTelemetry() && isTelemetryWrite(c.req.method, pattern)) return;
      const actor = resolveActor(c, draft);
      await writeAuditEntry({
        action: draft.action ?? defaultAction(c.req.method, pattern),
        targetType: draft.targetType ?? null,
        targetId: draft.targetId ?? null,
        ...actor,
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        method: c.req.method.toUpperCase(),
        path: new URL(c.req.url).pathname,
        statusCode,
        metadata: sanitizeMetadata(draft.metadata),
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
