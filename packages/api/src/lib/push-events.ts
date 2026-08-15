import { fanOutNotification } from "./apns.js";
import { log } from "./logger.js";

const DEFAULT_QUEUE_HIGH_THRESHOLD = 10;
const MAX_FLAGGED_DEDUP_ENTRIES = 1_000;

let queueHighActive = false;
const notifiedFlaggedModerations = new Set<string>();

export const moderationQueueHighThreshold = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = Number.parseInt(env.MODERATION_QUEUE_HIGH_THRESHOLD ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_HIGH_THRESHOLD;
};

export const notifyMessageFlagged = (
  messageId: string,
  moderationId: string,
  flagged: boolean,
): void => {
  if (!flagged || notifiedFlaggedModerations.has(moderationId)) return;
  notifiedFlaggedModerations.add(moderationId);
  if (notifiedFlaggedModerations.size > MAX_FLAGGED_DEDUP_ENTRIES) {
    const oldest = notifiedFlaggedModerations.values().next().value;
    if (oldest) notifiedFlaggedModerations.delete(oldest);
  }
  void fanOutNotification({
    preferenceKey: "messageFlagged",
    title: "Message flagged",
    body: "A booth recording needs operator attention.",
    threadId: `message:${messageId}`,
    category: "BOOTH_MESSAGE",
    data: { messageId, moderationId },
  });
};

/// Emits one alert when the queue crosses from below the configured threshold
/// to at-or-above it. Further arrivals are suppressed until a decision or
/// deletion brings the observed count below the threshold again.
export const observeModerationQueueCount = (count: number): void => {
  const threshold = moderationQueueHighThreshold();
  if (count < threshold) {
    queueHighActive = false;
    return;
  }
  if (queueHighActive) return;
  queueHighActive = true;
  log.info({ component: "apns", count, threshold }, "moderation queue reached high threshold");
  void fanOutNotification({
    preferenceKey: "moderationQueueHigh",
    title: "Moderation queue is high",
    body: `${count} booth recordings are waiting for review.`,
    badge: count,
    threadId: "moderation-queue",
    category: "BOOTH_MESSAGE",
    data: { awaitingModeration: count, threshold },
  });
};

export const resetPushEventStateForTests = (): void => {
  queueHighActive = false;
  notifiedFlaggedModerations.clear();
};
