// In-memory per-booth latest system snapshot. Operators read the live
// values via GET /v1/system/current and over the status WebSocket.
//
// VictoriaMetrics owns the time-series history (scraped via vmagent),
// so we deliberately do not write snapshots to Postgres — keeping the
// API stateless and cheap for high-frequency 5s pushes.

import type { BoothSystemSnapshot } from "@telephone-booth-operator/shared";

export type CachedSnapshot = {
  boothId: string;
  snapshot: BoothSystemSnapshot;
  receivedAt: string;
};

const snapshots = new Map<string, CachedSnapshot>();

export const setSystemSnapshot = (entry: CachedSnapshot): void => {
  snapshots.set(entry.boothId, entry);
};

export const getSystemSnapshot = (boothId: string): CachedSnapshot | undefined =>
  snapshots.get(boothId);

export const listSystemSnapshots = (): CachedSnapshot[] =>
  Array.from(snapshots.values()).sort((a, b) => a.boothId.localeCompare(b.boothId));

export const clearSystemSnapshotsForTests = (): void => {
  snapshots.clear();
};
