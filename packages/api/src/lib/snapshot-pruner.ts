// Periodic pruner for BoothStatusSnapshot rows. Keeps a bounded history
// to prevent unbounded Postgres growth in long-running installations.

import { db } from "./db.js";

interface PrunerConfig {
  retentionHours: number;
  minKeep: number;
  intervalSeconds: number;
}

const resolveConfig = (): PrunerConfig => ({
  retentionHours: Math.max(1, Number(process.env.STATUS_SNAPSHOT_RETENTION_HOURS) || 168),
  minKeep: Math.max(1, Number(process.env.STATUS_SNAPSHOT_MIN_KEEP) || 100),
  intervalSeconds: Math.max(60, Number(process.env.STATUS_SNAPSHOT_PRUNE_INTERVAL_SECONDS) || 3600),
});

export const pruneSnapshots = async (config?: PrunerConfig): Promise<number> => {
  const { retentionHours, minKeep } = config ?? resolveConfig();
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

  const totalCount = await db.boothStatusSnapshot.count();
  if (totalCount <= minKeep) return 0;

  // Find the id threshold: keep at least `minKeep` most recent rows.
  const keepBoundary = await db.boothStatusSnapshot.findMany({
    orderBy: { updatedAt: "desc" },
    skip: minKeep - 1,
    take: 1,
    select: { id: true, updatedAt: true },
  });

  if (keepBoundary.length === 0) return 0;

  // Delete rows that are both older than the retention cutoff AND outside
  // the min-keep boundary (i.e. not among the most recent `minKeep` rows).
  const boundary = keepBoundary[0];
  const deleteCutoff = boundary.updatedAt < cutoff ? cutoff : boundary.updatedAt;

  const result = await db.boothStatusSnapshot.deleteMany({
    where: {
      updatedAt: { lt: deleteCutoff },
      id: { lt: boundary.id },
    },
  });

  return result.count;
};

export interface PrunerHandle {
  stop(): void;
}

export const startSnapshotPruner = (): PrunerHandle => {
  const config = resolveConfig();
  const intervalMs = config.intervalSeconds * 1000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await pruneSnapshots(config);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "snapshot pruner failed";
      console.warn(JSON.stringify({ event: "snapshot.pruner.error", reason }));
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  handle.unref();

  // Run once shortly after boot.
  setTimeout(() => void tick(), 1_000).unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
  };
};
