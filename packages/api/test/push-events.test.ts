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

  it("does not submit an aggregate alert after a newer queue version exists", async () => {
    seedMessage({ status: "pending" });
    let releaseFirstAlert = (): void => undefined;
    let markFirstAlertStarted = (): void => undefined;
    const firstAlertStarted = new Promise<void>((resolve) => {
      markFirstAlertStarted = resolve;
    });
    const firstAlertGate = new Promise<void>((resolve) => {
      releaseFirstAlert = resolve;
    });
    const submittedCounts: number[] = [];
    let alertCount = 0;
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind !== "alert" || notification.preferenceKey !== "messageReceived") {
          return;
        }
        alertCount += 1;
        if (alertCount === 1) {
          markFirstAlertStarted();
          await firstAlertGate;
        }
        if (!(await beforeSubmit?.())) throw new Error("stale alert claim");
        submittedCounts.push(Number(notification.data?.awaitingModeration));
      },
    });

    const first = coordinated.notifyMessageReceived("message-1");
    await firstAlertStarted;
    seedMessage({ status: "pending" });
    await coordinated.notifyMessageReceived("message-2");
    releaseFirstAlert();
    await first;

    expect(submittedCounts).toEqual([2]);
  });

  it("submits a corrective badge after an older alert passes its fence", async () => {
    seedMessage({ status: "pending" });
    let releaseFirstPost = (): void => undefined;
    let markFirstFencePassed = (): void => undefined;
    const firstFencePassed = new Promise<void>((resolve) => {
      markFirstFencePassed = resolve;
    });
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    const submitted: Array<{ kind: "alert" | "badge"; count: number }> = [];
    let alertCount = 0;
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind === "badge") {
          submitted.push({ kind: "badge", count: notification.badge });
          return;
        }
        if (notification.preferenceKey !== "messageReceived") {
          return;
        }
        alertCount += 1;
        if (!(await beforeSubmit?.())) throw new Error("stale alert claim");
        if (alertCount === 1) {
          markFirstFencePassed();
          await firstPostGate;
        }
        submitted.push({
          kind: "alert",
          count: Number(notification.data?.awaitingModeration),
        });
      },
    });

    const first = coordinated.notifyMessageReceived("message-1");
    await firstFencePassed;
    seedMessage({ status: "pending" });
    await coordinated.notifyMessageReceived("message-2");

    releaseFirstPost();
    await first;

    expect(submitted.filter(({ kind }) => kind === "alert")).toEqual([
      { kind: "alert", count: 1 },
    ]);
    expect(submitted.at(-1)).toEqual({ kind: "badge", count: 2 });
  });

  it("submits a corrective badge after a superseded alert reaches APNs", async () => {
    const message = seedMessage({ status: "pending" });
    let releaseAlertPost = (): void => undefined;
    let markAlertFencePassed = (): void => undefined;
    const alertFencePassed = new Promise<void>((resolve) => {
      markAlertFencePassed = resolve;
    });
    const alertPostGate = new Promise<void>((resolve) => {
      releaseAlertPost = resolve;
    });
    const submitted: Array<{ kind: "alert" | "badge"; count: number }> = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind === "alert" && notification.preferenceKey === "messageReceived") {
          if (!(await beforeSubmit?.())) return;
          markAlertFencePassed();
          await alertPostGate;
          submitted.push({
            kind: "alert",
            count: Number(notification.data?.awaitingModeration),
          });
          return;
        }
        if (notification.kind === "badge") {
          submitted.push({ kind: "badge", count: notification.badge });
        }
      },
    });

    const alert = coordinated.notifyMessageReceived(message.id);
    await alertFencePassed;
    store.messages.get(message.id)!.status = "approved";
    await coordinated.observeModerationQueue("message.decision");
    releaseAlertPost();
    await alert;

    expect(submitted.at(-1)).toEqual({ kind: "badge", count: 0 });
  });

  it("keeps an in-flight alert pending when the queue decreases but remains non-empty", async () => {
    const older = seedMessage({ status: "pending" });
    seedMessage({ status: "pending" });
    let releaseFirstPost = (): void => undefined;
    let markFirstFencePassed = (): void => undefined;
    const firstFencePassed = new Promise<void>((resolve) => {
      markFirstFencePassed = resolve;
    });
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirstPost = resolve;
    });
    const submitted: Array<{ kind: "alert" | "badge"; count: number }> = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind === "badge") {
          submitted.push({ kind: "badge", count: notification.badge });
          return;
        }
        if (notification.preferenceKey !== "messageReceived") {
          return;
        }
        if (!(await beforeSubmit?.())) throw new Error("stale alert claim");
        markFirstFencePassed();
        await firstPostGate;
        submitted.push({
          kind: "alert",
          count: Number(notification.data?.awaitingModeration),
        });
      },
    });

    const alert = coordinated.notifyMessageReceived("new-message");
    await firstFencePassed;
    store.messages.get(older.id)!.status = "approved";
    await coordinated.observeModerationQueue("message.decision");
    releaseFirstPost();
    await alert;

    expect(submitted.filter(({ kind }) => kind === "alert")).toEqual([
      { kind: "alert", count: 2 },
    ]);
    expect(submitted.at(-1)).toEqual({ kind: "badge", count: 1 });
  });

  it("sends one message alert per non-empty queue cycle", async () => {
    const firstMessage = seedMessage({ status: "pending" });
    const submittedCounts: number[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        if (notification.kind === "alert" && notification.preferenceKey === "messageReceived") {
          submittedCounts.push(Number(notification.data?.awaitingModeration));
        }
      },
    });

    await coordinated.notifyMessageReceived(firstMessage.id);
    const secondMessage = seedMessage({ status: "pending" });
    await coordinated.notifyMessageReceived(secondMessage.id);
    store.messages.get(firstMessage.id)!.status = "approved";
    store.messages.get(secondMessage.id)!.status = "approved";
    await coordinated.observeModerationQueue("queue.empty");
    const thirdMessage = seedMessage({ status: "pending" });
    await coordinated.notifyMessageReceived(thirdMessage.id);

    expect(submittedCounts).toEqual([1, 1]);
  });

  it("skips the aggregate alert when no messages remain", async () => {
    const sent: ApnsNotification[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
    });

    await coordinated.notifyMessageReceived("already-moderated");

    expect(
      sent.filter(
        (notification) =>
          notification.kind === "alert" && notification.preferenceKey === "messageReceived",
      ),
    ).toEqual([]);
    expect(sent).toContainEqual({
      kind: "badge",
      badge: 0,
      data: { awaitingModeration: 0 },
    });
  });

  it("recovers a message alert when reconciliation first observes a queue increase", async () => {
    seedMessage({ status: "pending" });
    const sent: ApnsNotification[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
    });

    await coordinated.reconcileModerationBadgeState();
    await coordinated.dispatchMessageAlerts();

    expect(
      sent
        .filter(
          (notification) =>
            notification.kind === "alert" && notification.preferenceKey === "messageReceived",
        )
        .map((notification) => notification.data?.awaitingModeration),
    ).toEqual([1]);
  });

  it("recovers a new queue cycle after a previously delivered cycle emptied", async () => {
    store.pushNotificationStates.set("message-alert", {
      key: "message-alert",
      active: false,
      threshold: 0,
      badgeCount: 0,
      badgeVersion: 2,
      badgeDeliveredVersion: 2,
      badgeLeaseToken: null,
      badgeLeaseExpiresAt: null,
      updatedAt: new Date(),
    });
    seedMessage({ status: "pending" });
    const submittedCounts: number[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        if (notification.kind === "alert" && notification.preferenceKey === "messageReceived") {
          submittedCounts.push(Number(notification.data?.awaitingModeration));
        }
      },
    });

    await coordinated.reconcileModerationBadgeState();
    await coordinated.dispatchMessageAlerts();

    expect(submittedCounts).toEqual([1]);
  });

  it("keeps an aggregate alert valid across an unrelated badge refresh", async () => {
    seedMessage({ status: "pending" });
    let releaseAlert = (): void => undefined;
    let markAlertStarted = (): void => undefined;
    const alertStarted = new Promise<void>((resolve) => {
      markAlertStarted = resolve;
    });
    const alertGate = new Promise<void>((resolve) => {
      releaseAlert = resolve;
    });
    const submittedCounts: number[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind !== "alert" || notification.preferenceKey !== "messageReceived") {
          return;
        }
        markAlertStarted();
        await alertGate;
        if (await beforeSubmit?.()) {
          submittedCounts.push(Number(notification.data?.awaitingModeration));
        }
      },
    });

    const alert = coordinated.notifyMessageReceived("message-1");
    await alertStarted;
    await coordinated.queueModerationBadgeRefresh();
    releaseAlert();
    await alert;

    expect(submittedCounts).toEqual([1]);
  });

  it("retains a failed aggregate alert for a later retry", async () => {
    seedMessage({ status: "pending" });
    let alertAttempts = 0;
    const sentCounts: number[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        if (notification.kind !== "alert" || notification.preferenceKey !== "messageReceived") {
          return;
        }
        alertAttempts += 1;
        if (alertAttempts === 1) throw new Error("APNs unavailable");
        sentCounts.push(Number(notification.data?.awaitingModeration));
      },
    });

    await coordinated.notifyMessageReceived("message-1");

    let state = store.pushNotificationStates.get("message-alert");
    expect(state?.active).toBe(true);
    expect(state?.badgeDeliveredVersion).toBe(0);
    expect(state?.badgeLeaseToken).toBeNull();

    await coordinated.dispatchMessageAlerts();

    state = store.pushNotificationStates.get("message-alert");
    expect(alertAttempts).toBe(2);
    expect(sentCounts).toEqual([1]);
    expect(state?.active).toBe(false);
    expect(state?.badgeDeliveredVersion).toBe(state?.badgeVersion);
  });

  it("keeps aggregate alerts pending while APNs delivery is disabled", async () => {
    seedMessage({ status: "pending" });
    let enabled = false;
    const send = vi.fn(async (_notification: ApnsNotification) => undefined);
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send,
      badgeDeliveryEnabled: () => enabled,
    });

    await coordinated.notifyMessageReceived("message-1");

    let state = store.pushNotificationStates.get("message-alert");
    expect(
      send.mock.calls.some(
        ([notification]) =>
          notification.kind === "alert" && notification.preferenceKey === "messageReceived",
      ),
    ).toBe(false);
    expect(state?.active).toBe(true);
    expect(state?.badgeDeliveredVersion).toBe(0);

    enabled = true;
    await coordinated.dispatchMessageAlerts();

    state = store.pushNotificationStates.get("message-alert");
    expect(
      send.mock.calls.some(
        ([notification]) =>
          notification.kind === "alert" && notification.preferenceKey === "messageReceived",
      ),
    ).toBe(true);
    expect(state?.active).toBe(false);
    expect(state?.badgeDeliveredVersion).toBe(state?.badgeVersion);
  });

  it("invalidates an aggregate alert when the queue count decreases", async () => {
    const message = seedMessage({ status: "pending" });
    let releaseAlert = (): void => undefined;
    let markAlertStarted = (): void => undefined;
    const alertStarted = new Promise<void>((resolve) => {
      markAlertStarted = resolve;
    });
    const alertGate = new Promise<void>((resolve) => {
      releaseAlert = resolve;
    });
    const submittedCounts: number[] = [];
    const coordinated = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification, beforeSubmit) => {
        if (notification.kind !== "alert" || notification.preferenceKey !== "messageReceived") {
          return;
        }
        markAlertStarted();
        await alertGate;
        if (await beforeSubmit?.()) {
          submittedCounts.push(Number(notification.data?.awaitingModeration));
        }
      },
    });

    const alert = coordinated.notifyMessageReceived(message.id);
    await alertStarted;
    store.messages.get(message.id)!.status = "approved";
    await coordinated.observeModerationQueue("message.decision");
    releaseAlert();
    await alert;

    expect(submittedCounts).toEqual([]);
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
    expect(sent.filter((notification) => notification.kind === "badge")).toEqual([
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

  it("queues the current count again for a newly registered device", async () => {
    seedMessage({ status: "pending" });
    const sent: ApnsNotification[] = [];
    const registrationCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      send: async (notification) => {
        sent.push(notification);
      },
    });

    await registrationCoordinator.observeModerationQueue("initial-delivery");
    await registrationCoordinator.queueModerationBadgeRefresh();
    await registrationCoordinator.dispatchModerationBadges();

    const state = store.pushNotificationStates.get("moderation-queue-high");
    expect(state?.badgeCount).toBe(1);
    expect(state?.badgeVersion).toBe(2);
    expect(state?.badgeDeliveredVersion).toBe(2);
    expect(
      sent.filter((notification) => notification.kind === "badge").map(({ badge }) => badge),
    ).toEqual([1, 1]);
  });

  it("rejects a renewal that consumed the APNs submission window", async () => {
    seedMessage({ status: "pending" });
    const timestamps = [0, 0, 119_000];
    let submitted = false;
    const slowRenewalCoordinator = createPushEventCoordinator({
      database: fakeDb as never,
      now: () => new Date(timestamps.shift() ?? 119_000),
      send: async (notification, beforeSubmit) => {
        if (notification.kind !== "badge") return;
        const leaseExpiresAt = await beforeSubmit?.();
        if (!leaseExpiresAt) throw new Error("insufficient badge lease");
        submitted = true;
      },
    });

    await slowRenewalCoordinator.observeModerationQueue("slow-renewal");

    const state = store.pushNotificationStates.get("moderation-queue-high");
    expect(submitted).toBe(false);
    expect(state?.badgeDeliveredVersion).toBe(0);
    expect(state?.badgeLeaseToken).toBeNull();
  });
});
