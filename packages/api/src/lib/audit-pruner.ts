// Retention pruner for AuditLog rows.
//
// The trail is append-only and grows with operator activity, so long-running
// installations need a bound. Retention defaults to a year; set
// `AUDIT_LOG_RETENTION_DAYS=0` to keep rows forever (the pruner then never
// deletes anything).

import { db } from "./db.js";
import { log } from "./logger.js";

export interface AuditPrunerConfig {
  retentionDays: number;
  intervalSeconds: number;
}

// `Number("")` is 0, which would silently disable pruning forever, so a blank
// value falls back to the default while an explicit "0" still means "keep".
const positiveOrDefault = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const resolveAuditPrunerConfig = (): AuditPrunerConfig => {
  const retentionDays = positiveOrDefault(process.env.AUDIT_LOG_RETENTION_DAYS, 365);
  return {
    retentionDays,
    intervalSeconds: Math.max(
      300,
      positiveOrDefault(process.env.AUDIT_LOG_PRUNE_INTERVAL_SECONDS, 6 * 60 * 60) || 6 * 60 * 60,
    ),
  };
};

export const pruneAuditLogs = async (config?: AuditPrunerConfig): Promise<number> => {
  const { retentionDays } = config ?? resolveAuditPrunerConfig();
  if (retentionDays === 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
};

export interface AuditPrunerHandle {
  stop(): void;
}

export const startAuditPruner = (): AuditPrunerHandle => {
  const config = resolveAuditPrunerConfig();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pruneAuditLogs(config);
    } catch (error) {
      log.warn(
        {
          event: "audit.pruner.error",
          reason: error instanceof Error ? error.message : "audit pruner failed",
        },
        "audit log pruner failed",
      );
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, config.intervalSeconds * 1000);
  handle.unref();

  setTimeout(() => void tick(), 5_000).unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
  };
};
