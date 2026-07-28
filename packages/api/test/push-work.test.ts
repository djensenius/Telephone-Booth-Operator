import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import { findOutstandingPushWork, findOutstandingPushWorkPage } from "../src/lib/ai/push-work.js";
import { fakeDb, resetFakeDb, seedMessage } from "./support/fake-db.js";

describe("push work discovery", () => {
  beforeEach(() => {
    resetFakeDb();
    delete process.env.TRANSLATION_PROVIDER;
    delete process.env.MODERATION_PROVIDER;
  });

  it("merges pending translation and moderation needs for the same message", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const message = seedMessage({ status: "received" });
    const transcription = await fakeDb.transcription.create({
      data: {
        messageId: message.id,
        provider: "push",
        status: "succeeded",
        text: "bonjour",
        language: "fr",
        translationStatus: "pending",
        translationProvider: "push",
      },
    });
    await fakeDb.moderation.create({
      data: {
        messageId: message.id,
        transcriptionId: transcription.id,
        provider: "push",
        status: "pending",
      },
    });

    await expect(findOutstandingPushWork()).resolves.toEqual([
      { messageId: message.id, needs: ["translation", "moderation"] },
    ]);
  });

  it("honors staleBefore and limit for recovery sweeps", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    const oldest = seedMessage({ status: "received" });
    const newerStale = seedMessage({ status: "received" });
    const fresh = seedMessage({ status: "received" });

    for (const [messageId, createdAt] of [
      [oldest.id, new Date("2026-01-01T00:00:00.000Z")],
      [newerStale.id, new Date("2026-01-02T00:00:00.000Z")],
      [fresh.id, new Date("2026-01-03T00:00:00.000Z")],
    ] as const) {
      await fakeDb.transcription.create({
        data: {
          messageId,
          provider: "push",
          status: "succeeded",
          translationStatus: "pending",
          translationProvider: "push",
          createdAt,
        },
      });
    }

    await expect(
      findOutstandingPushWork({
        staleBefore: new Date("2026-01-02T12:00:00.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual([{ messageId: newerStale.id, needs: ["translation"] }]);
  });

  it("ignores pending downstream rows from superseded transcriptions", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const message = seedMessage({ status: "received" });
    const older = await fakeDb.transcription.create({
      data: {
        messageId: message.id,
        provider: "push",
        status: "succeeded",
        translationStatus: "pending",
        translationProvider: "push",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await fakeDb.moderation.create({
      data: {
        messageId: message.id,
        transcriptionId: older.id,
        provider: "push",
        status: "pending",
      },
    });
    await fakeDb.transcription.create({
      data: {
        messageId: message.id,
        provider: "push",
        status: "succeeded",
        translationStatus: "succeeded",
        translationProvider: "push",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });

    await expect(findOutstandingPushWork()).resolves.toEqual([]);
  });

  it("continues keyset pages across equal timestamps for both providers", async () => {
    process.env.TRANSLATION_PROVIDER = "push";
    process.env.MODERATION_PROVIDER = "push";
    const createdAt = new Date("2026-01-01T00:00:00.000Z");

    for (let i = 0; i < 2; i += 1) {
      const message = seedMessage({ status: "received" });
      await fakeDb.transcription.create({
        data: {
          messageId: message.id,
          provider: "push",
          status: "succeeded",
          translationStatus: "pending",
          translationProvider: "push",
          createdAt,
        },
      });
    }

    for (let i = 0; i < 2; i += 1) {
      const message = seedMessage({ status: "received" });
      const transcription = await fakeDb.transcription.create({
        data: {
          messageId: message.id,
          provider: "push",
          status: "succeeded",
          translationStatus: "succeeded",
          translationProvider: "push",
          createdAt,
        },
      });
      await fakeDb.moderation.create({
        data: {
          messageId: message.id,
          transcriptionId: transcription.id,
          provider: "push",
          status: "pending",
          createdAt,
        },
      });
    }

    const first = await findOutstandingPushWorkPage({ limit: 1 });
    const second = await findOutstandingPushWorkPage({ limit: 1, cursor: first.cursor });
    const firstIds = new Set(first.work.map((work) => work.messageId));

    expect(first.hasMore).toBe(true);
    expect(second.work.length).toBeGreaterThan(0);
    expect(second.work.every((work) => !firstIds.has(work.messageId))).toBe(true);
  });
});
