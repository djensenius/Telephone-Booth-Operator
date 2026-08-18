import type { ApnsNotification } from "./apns.js";
import { fanOutNotification } from "./apns.js";
import { db } from "./db.js";
import { log } from "./logger.js";
import { AWAITING_MODERATION_STATUSES } from "./moderation-badge.js";

const DEFAULT_QUEUE_HIGH_THRESHOLD = 10;
const QUEUE_HIGH_STATE_KEY = "moderation-queue-high";

type PushEventTransaction = {
  message: {
    count(args: { where: { status: { in: string[] } } }): Promise<number>;
  };
  pushNotificationState: {
    upsert(args: {
      where: { key: string };
      create: { key: string; active: boolean; threshold: number };
      update: Record<string, never>;
    }): Promise<{ key: string; active: boolean; threshold: number }>;
    update(args: {
      where: { key: string };
      data: { active: boolean; threshold: number };
    }): Promise<unknown>;
  };
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
  $transaction<T>(fn: (tx: PushEventTransaction) => Promise<T>): Promise<T>;
};

type PushEventCoordinatorOptions = {
  database: PushEventDatabase;
  send: (notification: ApnsNotification) => Promise<void>;
};

export const moderationQueueHighThreshold = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = Number.parseInt(env.MODERATION_QUEUE_HIGH_THRESHOLD ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_HIGH_THRESHOLD;
};

export const createPushEventCoordinator = ({
  database,
  send,
}: PushEventCoordinatorOptions): {
  notifyMessageFlagged(messageId: string, moderationId: string, flagged: boolean): Promise<void>;
  observeModerationQueue(operation: string): Promise<void>;
} => ({
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
          create: { key: QUEUE_HIGH_STATE_KEY, active: false, threshold },
          update: {},
        });
        const activeAtThisThreshold = state.threshold === threshold && state.active;
        const nextActive = count >= threshold;
        await tx.pushNotificationState.update({
          where: { key: QUEUE_HIGH_STATE_KEY },
          data: { active: nextActive, threshold },
        });
        return { count, shouldNotify: nextActive && !activeAtThisThreshold };
      });
      await send({
        kind: "badge",
        badge: result.count,
        data: { awaitingModeration: result.count },
      });
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
});

const coordinator = createPushEventCoordinator({
  database: db as unknown as PushEventDatabase,
  send: fanOutNotification,
});

export const notifyMessageFlagged = (
  messageId: string,
  moderationId: string,
  flagged: boolean,
): Promise<void> => coordinator.notifyMessageFlagged(messageId, moderationId, flagged);

export const observeModerationQueue = (operation: string): Promise<void> =>
  coordinator.observeModerationQueue(operation);
