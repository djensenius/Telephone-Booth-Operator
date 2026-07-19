import type { WorkNeed } from "../broadcaster.js";
import { db } from "../db.js";
import { resolveAiConfig } from "./config.js";

export type OutstandingPushWork = {
  messageId: string;
  needs: WorkNeed[];
};

export type PushWorkCursor = {
  createdAt: Date;
  id: string;
};

export type OutstandingPushWorkCursor = {
  translation?: PushWorkCursor;
  moderation?: PushWorkCursor;
};

export type OutstandingPushWorkPage = {
  work: OutstandingPushWork[];
  cursor: OutstandingPushWorkCursor;
  hasMore: boolean;
};

const addNeed = (workByMessage: Map<string, WorkNeed[]>, messageId: string, need: WorkNeed) => {
  const needs = workByMessage.get(messageId) ?? [];
  if (!needs.includes(need)) needs.push(need);
  workByMessage.set(messageId, needs);
};

const latestTranscriptionIdsForMessages = async (
  messageIds: readonly string[],
): Promise<Map<string, string>> => {
  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length === 0) return new Map();

  const rows = await db.transcription.findMany({
    where: { messageId: { in: uniqueMessageIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, messageId: true },
  });
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!latest.has(row.messageId)) latest.set(row.messageId, row.id);
  }
  return latest;
};

const keysetWhere = (cursor: PushWorkCursor | undefined) =>
  cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};

export const findOutstandingPushWorkPage = async (options: {
  staleBefore?: Date;
  limit?: number;
  cursor?: OutstandingPushWorkCursor;
} = {}): Promise<OutstandingPushWorkPage> => {
  const config = resolveAiConfig();
  const workByMessage = new Map<string, WorkNeed[]>();
  const createdAt = options.staleBefore ? { lt: options.staleBefore } : undefined;
  const take = options.limit ?? 100;
  const cursor: OutstandingPushWorkCursor = { ...options.cursor };
  let hasMore = false;

  const translations =
    config.translationProvider === "push"
      ? await db.transcription.findMany({
          where: {
            status: "succeeded",
            translationStatus: "pending",
            translationProvider: "push",
            ...(createdAt ? { createdAt } : {}),
            ...keysetWhere(options.cursor?.translation),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, createdAt: true, messageId: true },
        })
      : [];

  const moderations =
    config.moderationProvider === "push"
      ? await db.moderation.findMany({
          where: {
            status: "pending",
            provider: "push",
            ...(createdAt ? { createdAt } : {}),
            ...keysetWhere(options.cursor?.moderation),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, createdAt: true, messageId: true, transcriptionId: true },
        })
      : [];

  const latestIds = await latestTranscriptionIdsForMessages([
    ...translations.map((row) => row.messageId),
    ...moderations.map((row) => row.messageId),
  ]);

  if (config.translationProvider === "push") {
    for (const row of translations) {
      if (latestIds.get(row.messageId) === row.id) addNeed(workByMessage, row.messageId, "translation");
    }
    const last = translations.at(-1);
    if (last) cursor.translation = { id: last.id, createdAt: last.createdAt };
    hasMore ||= translations.length === take;
  }

  if (config.moderationProvider === "push") {
    for (const row of moderations) {
      if (row.transcriptionId && latestIds.get(row.messageId) === row.transcriptionId) {
        addNeed(workByMessage, row.messageId, "moderation");
      }
    }
    const last = moderations.at(-1);
    if (last) cursor.moderation = { id: last.id, createdAt: last.createdAt };
    hasMore ||= moderations.length === take;
  }

  return {
    work: [...workByMessage.entries()].map(([messageId, needs]) => ({ messageId, needs })),
    cursor,
    hasMore,
  };
};

export const findOutstandingPushWork = async (options: {
  staleBefore?: Date;
  limit?: number;
} = {}): Promise<OutstandingPushWork[]> => {
  const targetLimit = options.limit ?? 100;
  const work: OutstandingPushWork[] = [];
  let cursor: OutstandingPushWorkCursor | undefined;
  while (work.length === 0) {
    const page = await findOutstandingPushWorkPage({
      ...options,
      limit: targetLimit,
      ...(cursor ? { cursor } : {}),
    });
    work.push(...page.work);
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return work;
};
