import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import type { ApnsNotification } from "../src/lib/apns.js";
import { createPushEventCoordinator } from "../src/lib/push-events.js";
import { fakeDb, resetFakeDb, seedMessage, store } from "./support/fake-db.js";

const coordinator = (send: (notification: ApnsNotification) => Promise<void>) =>
  createPushEventCoordinator({
    database: fakeDb as never,
    send,
  });

describe("durable push event coordination", () => {
  beforeEach(() => {
    resetFakeDb();
    delete process.env.MODERATION_QUEUE_HIGH_THRESHOLD;
  });

  it("deduplicates a flagged moderation across coordinator instances and restarts", async () => {
    const message = seedMessage({ status: "pending" });
    const moderation = await fakeDb.moderation.create({
      data: {
        messageId: message.id,
        provider: "push",
        status: "succeeded",
        flagged: true,
        recommendation: "reject",
      },
    });
    const send = vi.fn(async (_notification: ApnsNotification) => undefined);

    await Promise.all([
      coordinator(send).notifyMessageFlagged(message.id, moderation.id, true),
      coordinator(send).notifyMessageFlagged(message.id, moderation.id, true),
      coordinator(send).notifyMessageFlagged(message.id, moderation.id, true),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    const stored = await fakeDb.moderation.findUnique({ where: { id: moderation.id } });
    expect(stored?.pushNotifiedAt).toBeInstanceOf(Date);
  });

  it("persists queue crossing state across instances and re-arms below the threshold", async () => {
    process.env.MODERATION_QUEUE_HIGH_THRESHOLD = "2";
    const sent: ApnsNotification[] = [];
    const send = vi.fn(async (notification: ApnsNotification) => {
      sent.push(notification);
    });

    const first = seedMessage({ status: "pending" });
    const second = seedMessage({ status: "pending" });
    await coordinator(send).observeModerationQueue("instance-1");
    await coordinator(send).observeModerationQueue("instance-2");
    seedMessage({ status: "pending" });
    await coordinator(send).observeModerationQueue("instance-3");
    store.messages.get(first.id)!.status = "approved";
    store.messages.get(second.id)!.status = "approved";
    await coordinator(send).observeModerationQueue("restarted-instance");
    seedMessage({ status: "pending" });
    await coordinator(send).observeModerationQueue("instance-4");
    seedMessage({ status: "pending" });
    await coordinator(send).observeModerationQueue("instance-5");

    expect(send).toHaveBeenCalledTimes(2);
    expect(sent.map((notification) => notification.badge)).toEqual([2, 2]);
  });
});
