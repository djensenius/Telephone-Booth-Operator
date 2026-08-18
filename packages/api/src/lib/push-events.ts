import { randomUUID } from "node:crypto";
import type { ApnsNotification } from "./apns.js";
import { fanOutBadgeNotification, fanOutNotification } from "./apns.js";
import { db } from "./db.js";
import { log } from "./logger.js";
import { AWAITING_MODERATION_STATUSES } from "./moderation-badge.js";

const DEFAULT_QUEUE_HIGH_THRESHOLD = 10;
const QUEUE_HIGH_STATE_KEY = "moderation-queue-high";
const BADGE_LEASE_DURATION_MS = 120_000;
const BADGE_DISPATCH_INTERVAL_MS = 5_000;
const BADGE_DISPATCH_BATCH_SIZE = 16;

type PushNotificationStateRow = {
  key: string;
  active: boolean;
  threshold: number;
  badgeCount: number;
  badgeVersion: number;
  badgeDeliveredVersion: number;
  badgeLeaseToken: string | null;
  badgeLeaseExpiresAt: Date | null;
  updatedAt: Date;
};

type PushNotificationStateStore = {
  findUnique(args: { where: { key: string } }): Promise<PushNotificationStateRow | null>;
  upsert(args: {
    where: { key: string };
    create: {
      key: string;
      active: boolean;
      threshold: number;
      badgeCount: number;
      badgeVersion: number;
      badgeDeliveredVersion: number;
    };
    update: Record<string, never>;
  }): Promise<PushNotificationStateRow>;
  update(args: {
    where: { key: string };
    data: Record<string, unknown>;
  }): Promise<PushNotificationStateRow>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

type PushEventTransaction = {
  message: {
    count(args: { where: { status: { in: string[] } } }): Promise<number>;
  };
  pushNotificationState: PushNotificationStateStore;
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
};

type PushEventDatabase = {
  moderation: {
    updateMany(args: {
      where: {
        id: string;
        messageId: string;
        flagged: true;
        pushNotifiedAt: null;
      };
      data: { pushNotifiedAt: Date };
    }): Promise<{ count: number }>;
  };
  pushNotificationState: PushNotificationStateStore;
  $transaction<T>(fn: (tx: PushEventTransaction) => Promise<T>): Promise<T>;
};

type PushEventCoordinatorOptions = {
  database: PushEventDatabase;
  send: (notification: ApnsNotification) => Promise<void>;
  now?: () => Date;
  createLeaseToken?: () => string;
  badgeLeaseDurationMs?: number;
};

type BadgeClaim = {
  count: number;
  version: number;
  leaseToken: string;
};

export const moderationQueueHighThreshold = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = Number.parseInt(env.MODERATION_QUEUE_HIGH_THRESHOLD ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_HIGH_THRESHOLD;
};

export const createPushEventCoordinator = ({
  database,
  send,
  now = () => new Date(),
  createLeaseToken = randomUUID,
  badgeLeaseDurationMs = BADGE_LEASE_DURATION_MS,
}: PushEventCoordinatorOptions): {
  dispatchModerationBadges(): Promise<void>;
  notifyMessageFlagged(messageId: string, moderationId: string, flagged: boolean): Promise<void>;
  observeModerationQueue(operation: string): Promise<void>;
} => {
  const claimModerationBadge = async (): Promise<BadgeClaim | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await database.pushNotificationState.findUnique({
        where: { key: QUEUE_HIGH_STATE_KEY },
      });
      if (!state || state.badgeVersion <= state.badgeDeliveredVersion) return null;

      const claimedAt = now();
      if (state.badgeLeaseExpiresAt && state.badgeLeaseExpiresAt > claimedAt) return null;

      const leaseToken = createLeaseToken();
      const claimed = await database.pushNotificationState.updateMany({
        where: {
          key: QUEUE_HIGH_STATE_KEY,
          badgeVersion: state.badgeVersion,
          badgeLeaseToken: state.badgeLeaseToken,
          badgeLeaseExpiresAt: state.badgeLeaseExpiresAt,
        },
        data: {
          badgeLeaseToken: leaseToken,
          badgeLeaseExpiresAt: new Date(claimedAt.getTime() + badgeLeaseDurationMs),
        },
      });
      if (claimed.count === 1) {
        return {
          count: state.badgeCount,
          version: state.badgeVersion,
          leaseToken,
        };
      }
    }

    return null;
  };

  const releaseModerationBadge = async (leaseToken: string): Promise<void> => {
    await database.pushNotificationState.updateMany({
      where: { key: QUEUE_HIGH_STATE_KEY, badgeLeaseToken: leaseToken },
      data: { badgeLeaseToken: null, badgeLeaseExpiresAt: null },
    });
  };

  const dispatchModerationBadges = async (): Promise<void> => {
    for (let delivered = 0; delivered < BADGE_DISPATCH_BATCH_SIZE; delivered += 1) {
      const claim = await claimModerationBadge();
      if (!claim) return;

      try {
        await send({
          kind: "badge",
          badge: claim.count,
          data: { awaitingModeration: claim.count },
        });
      } catch (error) {
        await releaseModerationBadge(claim.leaseToken);
        log.warn(
          { component: "apns", err: error, badge: claim.count, version: claim.version },
          "moderation badge delivery failed",
        );
        return;
      }

      const completed = await database.pushNotificationState.updateMany({
        where: {
          key: QUEUE_HIGH_STATE_KEY,
          badgeLeaseToken: claim.leaseToken,
        },
        data: {
          badgeDeliveredVersion: claim.version,
          badgeLeaseToken: null,
          badgeLeaseExpiresAt: null,
        },
      });
      if (completed.count === 0) {
        log.warn(
          { component: "apns", badge: claim.count, version: claim.version },
          "moderation badge delivery lease expired before completion",
        );
        return;
      }
    }
  };

  return {
    dispatchModerationBadges,

    async notifyMessageFlagged(messageId, moderationId, flagged) {
      if (!flagged) return;
      try {
        const claimed = await database.moderation.updateMany({
          where: {
            id: moderationId,
            messageId,
            flagged: true,
            pushNotifiedAt: null,
          },
          data: { pushNotifiedAt: new Date() },
        });
        if (claimed.count === 0) return;
        await send({
          kind: "alert",
          preferenceKey: "messageFlagged",
          title: "Message flagged",
          body: "A booth recording needs operator attention.",
          threadId: `message:${messageId}`,
          category: "BOOTH_MESSAGE",
          data: { messageId, moderationId },
        });
      } catch (error) {
        log.warn(
          { component: "apns", err: error, messageId, moderationId },
          "failed to claim or fan out flagged-message push",
        );
      }
    },

    async observeModerationQueue(operation) {
      const threshold = moderationQueueHighThreshold();
      try {
        const result = await database.$transaction(async (tx) => {
          // Serialize all queue observations across replicas before reading the
          // count. The durable row survives restarts; the transaction-scoped
          // advisory lock prevents stale concurrent observations from
          // overwriting a newer crossing state.
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(hashtext(${QUEUE_HIGH_STATE_KEY}))
          `;
          const count = await tx.message.count({
            where: { status: { in: [...AWAITING_MODERATION_STATUSES] } },
          });
          const state = await tx.pushNotificationState.upsert({
            where: { key: QUEUE_HIGH_STATE_KEY },
            create: {
              key: QUEUE_HIGH_STATE_KEY,
              active: false,
              threshold,
              badgeCount: 0,
              badgeVersion: 0,
              badgeDeliveredVersion: 0,
            },
            update: {},
          });
          const activeAtThisThreshold = state.threshold === threshold && state.active;
          const nextActive = count >= threshold;
          await tx.pushNotificationState.update({
            where: { key: QUEUE_HIGH_STATE_KEY },
            data: {
              active: nextActive,
              threshold,
              badgeCount: count,
              badgeVersion: { increment: 1 },
            },
          });
          return { count, shouldNotify: nextActive && !activeAtThisThreshold };
        });
        await dispatchModerationBadges();
        if (!result.shouldNotify) return;
        log.info(
          { component: "apns", count: result.count, threshold },
          "moderation queue reached high threshold",
        );
        await send({
          kind: "alert",
          preferenceKey: "moderationQueueHigh",
          title: "Moderation queue is high",
          body: `${result.count} booth recordings are waiting for review.`,
          threadId: "moderation-queue",
          category: "BOOTH_MESSAGE",
          data: { awaitingModeration: result.count, threshold },
        });
      } catch (error) {
        log.warn(
          { component: "apns", err: error, operation, threshold },
          "failed to observe or fan out moderation queue push",
        );
      }
    },
  };
};

const coordinator = createPushEventCoordinator({
  database: db as unknown as PushEventDatabase,
  send: (notification) =>
    notification.kind === "badge"
      ? fanOutBadgeNotification(notification)
      : fanOutNotification(notification),
});

export const notifyMessageFlagged = (
  messageId: string,
  moderationId: string,
  flagged: boolean,
): Promise<void> => coordinator.notifyMessageFlagged(messageId, moderationId, flagged);

export const observeModerationQueue = (operation: string): Promise<void> =>
  coordinator.observeModerationQueue(operation);

export const dispatchModerationBadges = (): Promise<void> => coordinator.dispatchModerationBadges();

export const startModerationBadgeDispatcher = (): { stop: () => void } => {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchModerationBadges();
    } catch (error) {
      log.warn({ component: "apns", err: error }, "moderation badge dispatcher failed");
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => void tick(), 1_000);
  const interval = setInterval(() => void tick(), BADGE_DISPATCH_INTERVAL_MS);
  initialTimer.unref();
  interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
};
