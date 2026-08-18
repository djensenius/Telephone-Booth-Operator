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

    expect(
      sent
        .filter((notification) => notification.kind === "badge")
        .map((notification) => notification.badge),
    ).toEqual([2, 2, 3, 1, 2, 3]);
    expect(
      sent
        .filter(
          (notification) =>
            notification.kind === "alert" && notification.preferenceKey === "moderationQueueHigh",
        )
        .map((notification) => notification.data?.awaitingModeration),
    ).toEqual([2, 2]);
  });

  it("serializes in-flight badge delivery and coalesces newer counts", async () => {
    const sentBadges: number[] = [];
    let releaseFirstSend = (): void => undefined;
    let markFirstSendStarted = (): void => undefined;
    const firstSendStarted = new Promise<void>((resolve) => {
      markFirstSendStarted = resolve;
    });
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const send = vi.fn(async (notification: ApnsNotification) => {
      if (notification.kind !== "badge") return;
      sentBadges.push(notification.badge);
      if (sentBadges.length === 1) {
        markFirstSendStarted();
        await firstSendGate;
      }
    });

    const first = seedMessage({ status: "pending" });
    const second = seedMessage({ status: "pending" });
    const firstObservation = coordinator(send).observeModerationQueue("replica-1");
    await firstSendStarted;

    store.messages.get(first.id)!.status = "approved";
    await coordinator(send).observeModerationQueue("replica-2");
    store.messages.get(second.id)!.status = "approved";
    await coordinator(send).observeModerationQueue("replica-3");

    expect(sentBadges).toEqual([2]);
    releaseFirstSend();
    await firstObservation;

    expect(sentBadges).toEqual([2, 0]);
    const state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeDeliveredVersion).toBe(state?.badgeVersion);
    expect(state?.badgeLeaseToken).toBeNull();
  });

  it("recovers pending badge delivery after a stale lease and coordinator restart", async () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    store.pushNotificationStates.set("moderation-queue-high", {
      key: "moderation-queue-high",
      active: false,
      threshold: 10,
      badgeCount: 4,
      badgeVersion: 3,
      badgeDeliveredVersion: 2,
      badgeLeaseToken: "crashed-replica",
      badgeLeaseExpiresAt: new Date(now.getTime() - 1),
      updatedAt: new Date(now.getTime() - 60_000),
    });
    const sent: ApnsNotification[] = [];
    const restartedCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
      now: () => now,
      createLeaseToken: () => "recovered-replica",
    });

    await restartedCoordinator.dispatchModerationBadges();

    expect(sent).toEqual([{ kind: "badge", badge: 4, data: { awaitingModeration: 4 } }]);
    const state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeDeliveredVersion).toBe(3);
    expect(state?.badgeLeaseToken).toBeNull();
    expect(state?.badgeLeaseExpiresAt).toBeNull();
  });

  it("retains a badge version after delivery failure and retries it", async () => {
    seedMessage({ status: "pending" });
    let badgeAttempts = 0;
    const retryingCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        if (notification.kind !== "badge") return;
        badgeAttempts += 1;
        if (badgeAttempts === 1) throw new Error("APNs unavailable");
      },
    });

    await retryingCoordinator.observeModerationQueue("first-attempt");

    let state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeDeliveredVersion).toBe(0);
    expect(state?.badgeVersion).toBe(1);
    expect(state?.badgeLeaseToken).toBeNull();

    await retryingCoordinator.dispatchModerationBadges();

    state = store.pushNotificationStates.get("moderation-queue-high");
    expect(badgeAttempts).toBe(2);
    expect(state?.badgeDeliveredVersion).toBe(1);
    expect(state?.badgeLeaseToken).toBeNull();
  });

  it("keeps delivery pending while APNs is disabled and sends when enabled", async () => {
    seedMessage({ status: "pending" });
    let enabled = false;
    const send = vi.fn(async (_notification: ApnsNotification) => undefined);
    const gatedCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send,
      badgeDeliveryEnabled: () => enabled,
    });

    await gatedCoordinator.observeModerationQueue("disabled");

    let state = store.pushNotificationStates.get("moderation-queue-high");
    expect(send).not.toHaveBeenCalled();
    expect(state?.badgeDeliveredVersion).toBe(0);
    expect(state?.badgeVersion).toBe(1);

    enabled = true;
    await gatedCoordinator.dispatchModerationBadges();

    state = store.pushNotificationStates.get("moderation-queue-high");
    expect(send).toHaveBeenCalledWith(
      {
        kind: "badge",
        badge: 1,
        data: { awaitingModeration: 1 },
      },
      expect.any(Function),
    );
    expect(state?.badgeDeliveredVersion).toBe(1);
  });

  it("reconciles missed queue changes without versioning unchanged counts", async () => {
    const message = seedMessage({ status: "pending" });
    const sent: ApnsNotification[] = [];
    const reconcilingCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
    });

    await reconcilingCoordinator.reconcileModerationBadgeState();
    let state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeCount).toBe(1);
    expect(state?.badgeVersion).toBe(1);
    expect(state?.badgeDeliveredVersion).toBe(1);

    await reconcilingCoordinator.reconcileModerationBadgeState();
    state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeVersion).toBe(1);

    store.messages.get(message.id)!.status = "approved";
    await reconcilingCoordinator.reconcileModerationBadgeState();

    state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeCount).toBe(0);
    expect(state?.badgeVersion).toBe(2);
    expect(state?.badgeDeliveredVersion).toBe(2);
    expect(sent).toEqual([
      { kind: "badge", badge: 1, data: { awaitingModeration: 1 } },
      { kind: "badge", badge: 0, data: { awaitingModeration: 0 } },
    ]);
  });

  it("initializes delivery for a pre-dispatch badge state", async () => {
    store.pushNotificationStates.set("moderation-queue-high", {
      key: "moderation-queue-high",
      active: false,
      threshold: 10,
      badgeCount: 0,
      badgeVersion: 0,
      badgeDeliveredVersion: 0,
      badgeLeaseToken: null,
      badgeLeaseExpiresAt: null,
      updatedAt: new Date(),
    });
    const migratedCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (_notification) => undefined,
    });

    await migratedCoordinator.reconcileModerationBadgeState();

    expect(store.pushNotificationStates.get("moderation-queue-high")?.badgeVersion).toBe(1);
  });

  it("emits a queue-high alert when reconciliation observes the crossing first", async () => {
    process.env.MODERATION_QUEUE_HIGH_THRESHOLD = "2";
    seedMessage({ status: "pending" });
    seedMessage({ status: "pending" });
    const sent: ApnsNotification[] = [];
    const reconcilingCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
    });

    await reconcilingCoordinator.reconcileModerationBadgeState();
    await reconcilingCoordinator.reconcileModerationBadgeState();

    expect(
      sent.filter(
        (notification) =>
          notification.kind === "alert" && notification.preferenceKey === "moderationQueueHigh",
      ),
    ).toHaveLength(1);
  });

  it("fences a claimed badge before submission after lease ownership is lost", async () => {
    seedMessage({ status: "pending" });
    let submitted = false;
    const fencedCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind !== "badge") return;
        const state = store.pushNotificationStates.get("moderation-queue-high");
        if (!state) throw new Error("missing badge state");
        state.badgeLeaseToken = "newer-replica";
        state.badgeLeaseExpiresAt = new Date(Date.now() + 60_000);
        const leaseExpiresAt = await beforeSubmit?.();
        if (!leaseExpiresAt) throw new Error("stale badge claim");
        submitted = true;
      },
    });

    await fencedCoordinator.observeModerationQueue("lost-lease");

    const state = store.pushNotificationStates.get("moderation-queue-high");
    expect(submitted).toBe(false);
    expect(state?.badgeDeliveredVersion).toBe(0);
    expect(state?.badgeLeaseToken).toBe("newer-replica");
  });
});
