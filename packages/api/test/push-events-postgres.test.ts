import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ApnsNotification } from "../src/lib/apns.js";
import { db } from "../src/lib/db.js";
import { createPushEventCoordinator } from "../src/lib/push-events.js";

const describeWithDatabase = process.env["RUN_DATABASE_TESTS"] === "1" ? describe : describe.skip;
const stateKeys = ["message-alert", "moderation-queue-high"];

describeWithDatabase("push event coordination with PostgreSQL", () => {
  const messageIds: string[] = [];
  const fileIds: string[] = [];

  beforeEach(async () => {
    await db.pushNotificationState.deleteMany({ where: { key: { in: stateKeys } } });
  });

  afterEach(async () => {
    await db.message.deleteMany({ where: { id: { in: messageIds } } });
    await db.file.deleteMany({ where: { id: { in: fileIds } } });
    await db.pushNotificationState.deleteMany({ where: { key: { in: stateKeys } } });
    messageIds.length = 0;
    fileIds.length = 0;
  });

  const createPendingMessage = async (): Promise<string> => {
    const suffix = randomUUID();
    const file = await db.file.create({
      data: {
        blobContainer: "audio",
        blobKey: `messages/push-postgres-${suffix}.flac`,
        sha256: suffix.replaceAll("-", "").padEnd(64, "0"),
        sizeBytes: 1,
        durationMs: 1_000,
        contentType: "audio/flac",
      },
    });
    fileIds.push(file.id);
    const message = await db.message.create({
      data: {
        status: "pending",
        audioId: file.id,
        receivedAt: new Date(),
      },
    });
    messageIds.push(message.id);
    return message.id;
  };

  it("reads the newest queue count after a competing replica holds the advisory lock", async () => {
    const baseline = await db.message.count({
      where: { status: { in: ["received", "pending"] } },
    });
    const firstMessageId = await createPendingMessage();
    let releaseBlocker!: () => void;
    let markBlockerLocked!: () => void;
    let markFirstWaiting!: () => void;
    const blockerLocked = new Promise<void>((resolve) => {
      markBlockerLocked = resolve;
    });
    const firstWaiting = new Promise<void>((resolve) => {
      markFirstWaiting = resolve;
    });
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(hashtext(${"moderation-queue-high"}))) AS acquired
      `;
      markBlockerLocked();
      await blockerGate;
    });
    await blockerLocked;

    const database = {
      moderation: db.moderation,
      pushNotificationState: db.pushNotificationState,
      $transaction: <T>(
        operation: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<T>,
      ): Promise<T> =>
        db.$transaction(async (tx) =>
          operation(
            new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
                return (...args: unknown[]) => {
                  markFirstWaiting();
                  return Reflect.apply(target.$queryRaw, target, args);
                };
              },
            }),
          ),
        ),
    };
    let submittedAlerts = 0;
    const send = vi.fn(async (notification: ApnsNotification) => {
      if (notification.kind === "alert" && notification.preferenceKey === "messageReceived") {
        submittedAlerts += 1;
      }
    });
    const firstCoordinator = createPushEventCoordinator({ database: database as never, send });
    const secondCoordinator = createPushEventCoordinator({ database: db as never, send });

    try {
      const firstNotification = firstCoordinator.notifyMessageReceived(firstMessageId);
      await Promise.race([
        firstWaiting,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("first coordinator did not reach advisory lock")),
            1_000,
          );
        }),
      ]);
      const secondMessageId = await createPendingMessage();
      const secondNotification = secondCoordinator.notifyMessageReceived(secondMessageId);
      releaseBlocker();
      await Promise.all([firstNotification, secondNotification]);

      const expectedCount = baseline + 2;
      expect(submittedAlerts).toBe(1);
      const state = await db.pushNotificationState.findUnique({ where: { key: "message-alert" } });
      expect(state?.badgeCount).toBe(expectedCount);
      expect(state?.active).toBe(false);
      expect(state?.threshold).toBe(1);
    } finally {
      releaseBlocker();
      await blocker;
    }
  });
});
