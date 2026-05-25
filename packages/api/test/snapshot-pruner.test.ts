import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import { pruneSnapshots } from "../src/lib/snapshot-pruner.js";
import { resetFakeDb, seedStatus, store } from "./support/fake-db.js";

const hours = (h: number): number => h * 60 * 60 * 1000;

describe("pruneSnapshots", () => {
  beforeEach(() => {
    resetFakeDb();
  });

  it("keeps all rows when count is at or below minKeep", async () => {
    seedStatus({ updatedAt: new Date(Date.now() - hours(200)) });
    seedStatus({ updatedAt: new Date(Date.now() - hours(100)) });

    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 5, intervalSeconds: 60 });
    expect(deleted).toBe(0);
  });

  it("keeps recent rows within retention window", async () => {
    // All 5 rows are recent (within 24h)
    for (let i = 0; i < 5; i++) {
      seedStatus({ updatedAt: new Date(Date.now() - hours(i)) });
    }

    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 2, intervalSeconds: 60 });
    expect(deleted).toBe(0);
  });

  it("deletes old rows beyond retention window", async () => {
    // 3 old rows (outside 24h window)
    seedStatus({ updatedAt: new Date(Date.now() - hours(72)) });
    seedStatus({ updatedAt: new Date(Date.now() - hours(48)) });
    seedStatus({ updatedAt: new Date(Date.now() - hours(36)) });
    // 2 recent rows
    seedStatus({ updatedAt: new Date(Date.now() - hours(6)) });
    seedStatus({ updatedAt: new Date(Date.now() - hours(1)) });

    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 2, intervalSeconds: 60 });
    expect(deleted).toBe(3);
  });

  it("preserves rows within retention window even beyond minKeep", async () => {
    const snapshots = [48, 36, 18, 12, 6, 1].map((ageHours) =>
      seedStatus({ updatedAt: new Date(Date.now() - hours(ageHours)) }),
    );

    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 2, intervalSeconds: 60 });

    expect(deleted).toBe(2);
    expect(store.statuses.map((status) => status.id)).toEqual([
      snapshots[2]!.id,
      snapshots[3]!.id,
      snapshots[4]!.id,
      snapshots[5]!.id,
    ]);
  });

  it("always keeps at least minKeep rows even if all are old", async () => {
    const snapshots = [204, 203, 202, 201, 200].map((ageHours) =>
      seedStatus({ updatedAt: new Date(Date.now() - hours(ageHours)) }),
    );

    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 3, intervalSeconds: 60 });
    expect(deleted).toBe(2);
    expect(store.statuses.map((status) => status.id)).toEqual([
      snapshots[2]!.id,
      snapshots[3]!.id,
      snapshots[4]!.id,
    ]);
  });

  it("is a no-op on empty table", async () => {
    const deleted = await pruneSnapshots({ retentionHours: 24, minKeep: 5, intervalSeconds: 60 });
    expect(deleted).toBe(0);
  });
});
