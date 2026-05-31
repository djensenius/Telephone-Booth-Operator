// Aggregated booth status + queue counters for mobile widgets / dashboards.
// Results are memoized for STATS_CACHE_TTL_MS so that high-frequency widget
// timelines don't fan out into N Postgres queries per refresh.

import { Hono } from "hono";
import {
  STATS_WINDOW_VALUES,
  StatsWindowSchema,
  statsWindowDurationMs,
  type StatsOverview,
  type StatsWindow,
} from "@telephone-booth-operator/shared";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { countMessagesAwaitingModeration } from "../lib/moderation-badge.js";
import { defaultStatus, serializeStatus } from "../lib/serializers.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

const STATS_CACHE_TTL_MS = 5_000;
const OVERVIEW_CACHE_TTL_MS = 30_000;
const TOP_QUESTION_LIMIT = 10;
const PLAYING_MESSAGE_STATE = "playing_message";
const MAX_MESSAGES_PER_OVERVIEW = 5_000;

type StatsSummary = {
  booth: ReturnType<typeof serializeStatus>;
  messages: {
    pending: number;
    awaitingModeration: number;
    receivedToday: number;
    latestId: string | null;
  };
  calls: {
    today: number;
    inProgress: number;
  };
  realtime: {
    wsClients: number;
  };
  generatedAt: string;
};

let cached: { value: StatsSummary; expiresAt: number } | null = null;

const computeStatsSummary = async (): Promise<StatsSummary> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    latestStatus,
    pendingCount,
    awaitingModeration,
    receivedToday,
    latestMessage,
    callsToday,
    callsInProgress,
  ] = await Promise.all([
    db.boothStatusSnapshot.findFirst({ orderBy: { updatedAt: "desc" } }),
    db.message.count({ where: { status: "pending" } }),
    countMessagesAwaitingModeration(),
    db.message.count({ where: { createdAt: { gte: startOfDay } } }),
    db.message.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } }),
    db.callSession.count({ where: { startedAt: { gte: startOfDay } } }),
    db.callSession.count({ where: { endedAt: null } }),
  ]);

  return {
    booth: latestStatus ? serializeStatus(latestStatus) : defaultStatus(),
    messages: {
      pending: pendingCount,
      awaitingModeration,
      receivedToday,
      latestId: latestMessage?.id ?? null,
    },
    calls: {
      today: callsToday,
      inProgress: callsInProgress,
    },
    realtime: {
      wsClients: wsBroadcaster.size,
    },
    generatedAt: new Date().toISOString(),
  };
};

const getCachedSummary = async (): Promise<StatsSummary> => {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await computeStatsSummary();
  cached = { value, expiresAt: now + STATS_CACHE_TTL_MS };
  return value;
};

export const resetStatsCacheForTests = (): void => {
  cached = null;
  overviewCache.clear();
};

// -----------------------------------------------------------------------------
// /v1/stats/overview — historical aggregation across calls, messages, booth
// events. Aggregation is done in JS over `findMany` results (no $queryRaw)
// to keep the route trivially testable against the in-memory fake-db; the
// row counts on a real installation are small enough that this is fine.
// -----------------------------------------------------------------------------

const overviewCache = new Map<StatsWindow, { value: StatsOverview; expiresAt: number }>();

type CallSessionRow = {
  id: string;
  boothId: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  digitsDialed: string | null;
  durationMs: number | null;
};

type MessageRow = {
  status: string;
  createdAt: Date;
  questionId: string | null;
  audio: { durationMs: number | null } | null;
};

type BoothEventRow = {
  type: string;
  occurredAt: Date;
  payload: unknown;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const incRecord = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

const buildHourly = (
  callTimes: Date[],
  messageTimes: Date[],
): StatsOverview["hourly"] => {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    calls: 0,
    messages: 0,
  }));
  for (const time of callTimes) {
    const bucket = buckets[time.getUTCHours()];
    if (bucket) bucket.calls += 1;
  }
  for (const time of messageTimes) {
    const bucket = buckets[time.getUTCHours()];
    if (bucket) bucket.messages += 1;
  }
  return buckets;
};

const buildPerDay = (
  rangeStart: Date | null,
  rangeEnd: Date,
  sessions: CallSessionRow[],
): StatsOverview["calls"]["perDay"] => {
  // Determine the day range to zero-fill.
  const startDay = rangeStart ?? minStartedAt(sessions) ?? rangeEnd;
  const out = new Map<string, { total: number; completed: number }>();
  const cursor = new Date(
    Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()),
  );
  const endDay = new Date(
    Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate()),
  );
  while (cursor.getTime() <= endDay.getTime()) {
    out.set(isoDay(cursor), { total: 0, completed: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const session of sessions) {
    const key = isoDay(session.startedAt);
    const bucket = out.get(key) ?? { total: 0, completed: 0 };
    bucket.total += 1;
    if (session.outcome === "recording_completed") bucket.completed += 1;
    out.set(key, bucket);
  }
  return Array.from(out.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};

const minStartedAt = (sessions: CallSessionRow[]): Date | null => {
  if (sessions.length === 0) return null;
  let min = sessions[0]?.startedAt ?? null;
  for (const session of sessions) {
    if (!min || session.startedAt < min) min = session.startedAt;
  }
  return min;
};

const tallyDigits = (sessions: CallSessionRow[]): Record<string, number> => {
  const digits: Record<string, number> = {};
  for (let i = 0; i < 10; i += 1) digits[String(i)] = 0;
  for (const session of sessions) {
    if (!session.digitsDialed) continue;
    for (const char of session.digitsDialed) {
      if (char in digits) digits[char] = (digits[char] ?? 0) + 1;
    }
  }
  return digits;
};

const playbackCount = (events: BoothEventRow[]): number => {
  let count = 0;
  for (const event of events) {
    if (event.type !== "state_transition") continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const to = (payload as { to?: unknown }).to;
    if (to === PLAYING_MESSAGE_STATE) count += 1;
  }
  return count;
};

const findBusiest = (
  hourly: StatsOverview["hourly"],
  perDay: StatsOverview["calls"]["perDay"],
): StatsOverview["busiest"] => {
  let hour: number | null = null;
  let hourPeak = 0;
  for (const bucket of hourly) {
    if (bucket.calls > hourPeak) {
      hour = bucket.hour;
      hourPeak = bucket.calls;
    }
  }
  const dayTotals = new Map<number, number>();
  for (const day of perDay) {
    const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    dayTotals.set(dow, (dayTotals.get(dow) ?? 0) + day.total);
  }
  let dayOfWeek: number | null = null;
  let dayPeak = 0;
  for (const [dow, total] of dayTotals) {
    if (total > dayPeak) {
      dayOfWeek = dow;
      dayPeak = total;
    }
  }
  return { hour, dayOfWeek };
};

const computeStatsOverview = async (window: StatsWindow): Promise<StatsOverview> => {
  const generatedAt = new Date();
  const windowMs = statsWindowDurationMs(window);
  const rangeEnd = generatedAt;
  const rangeStart = windowMs === null ? null : new Date(rangeEnd.getTime() - windowMs);
  const startedFilter = rangeStart ? { gte: rangeStart } : undefined;
  const endedFilter = rangeStart ? { gte: rangeStart } : undefined;

  const [
    sessionsByStart,
    sessionsByEnd,
    sessionsEndedInWindow,
    inProgressCount,
    messages,
    stateTransitionEvents,
    uploadEvents,
    latestEvent,
    questions,
  ] = await Promise.all([
    db.callSession.findMany({
      where: startedFilter ? { startedAt: startedFilter } : {},
    }) as unknown as Promise<CallSessionRow[]>,
    db.callSession.findMany({
      where: endedFilter ? { endedAt: endedFilter, outcome: { not: null } } : { outcome: { not: null } },
    }) as unknown as Promise<CallSessionRow[]>,
    // Used for the pickup/hangup panel — counts sessions whose endedAt fell
    // inside the window regardless of outcome, so the panel reconciles with
    // calls.* at window boundaries (a call that started before the window
    // but hung up inside it still counts as one hangup here).
    db.callSession.count({
      where: endedFilter ? { endedAt: endedFilter } : { endedAt: { not: null } },
    }),
    db.callSession.count({ where: { endedAt: null } }),
    db.message.findMany({
      where: startedFilter ? { createdAt: startedFilter } : {},
      include: { audio: true },
      take: MAX_MESSAGES_PER_OVERVIEW,
    }) as unknown as Promise<MessageRow[]>,
    db.boothEvent.findMany({
      where: startedFilter
        ? { type: "state_transition", occurredAt: startedFilter }
        : { type: "state_transition" },
    }) as unknown as Promise<BoothEventRow[]>,
    db.boothEvent.findMany({
      where: startedFilter
        ? { type: { in: ["upload_completed", "upload_failed"] }, occurredAt: startedFilter }
        : { type: { in: ["upload_completed", "upload_failed"] } },
    }) as unknown as Promise<BoothEventRow[]>,
    db.boothEvent.findFirst({
      orderBy: [{ receivedAt: "desc" }],
    }) as unknown as Promise<{ receivedAt: Date } | null>,
    db.question.findMany({}) as unknown as Promise<
      Array<{ id: string; prompt: string; retiredAt: Date | null }>
    >,
  ]);

  // calls.*
  const callsCompleted = sessionsByEnd.filter((s) => s.outcome === "recording_completed").length;
  const completedDurations = sessionsByEnd
    .filter((s) => typeof s.durationMs === "number" && s.durationMs !== null)
    .map((s) => s.durationMs as number);
  const averageDurationMs =
    completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : null;
  const longestDurationMs = completedDurations.length > 0 ? Math.max(...completedDurations) : null;
  const outcomes: Record<string, number> = {};
  for (const session of sessionsByEnd) {
    incRecord(outcomes, session.outcome ?? "unknown");
  }
  const perDay = buildPerDay(rangeStart, rangeEnd, sessionsByStart);

  // messages.*
  const byStatus: Record<string, number> = {};
  for (const message of messages) incRecord(byStatus, message.status);
  const messageDurations = messages
    .map((m) => m.audio?.durationMs)
    .filter((d): d is number => typeof d === "number");
  const messagesAverageDurationMs =
    messageDurations.length > 0
      ? messageDurations.reduce((a, b) => a + b, 0) / messageDurations.length
      : null;

  // playback
  const totalPlaybacks = playbackCount(stateTransitionEvents);

  // pickups (started in window) and hangups (ended in window). Derived from
  // CallSession so the count always reconciles with calls.* on either side
  // of the window boundary.
  const hangups = sessionsEndedInWindow;
  const digitsDialed = tallyDigits(sessionsByStart);

  // uploads
  const uploadSucceeded = uploadEvents.filter((e) => e.type === "upload_completed").length;
  const uploadFailed = uploadEvents.filter((e) => e.type === "upload_failed").length;
  const uploadTotal = uploadSucceeded + uploadFailed;
  const uploadFailureRate = uploadTotal > 0 ? uploadFailed / uploadTotal : null;

  // top questions
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const messageCounts = new Map<string, { count: number; lastUsedAt: Date | null }>();
  for (const message of messages) {
    if (!message.questionId) continue;
    const existing = messageCounts.get(message.questionId) ?? { count: 0, lastUsedAt: null };
    existing.count += 1;
    if (!existing.lastUsedAt || message.createdAt > existing.lastUsedAt) {
      existing.lastUsedAt = message.createdAt;
    }
    messageCounts.set(message.questionId, existing);
  }
  const topQuestions = Array.from(messageCounts.entries())
    .map(([questionId, info]) => {
      const question = questionsById.get(questionId);
      return {
        questionId,
        prompt: question?.prompt ?? "(deleted question)",
        messageCount: info.count,
        lastUsedAt: info.lastUsedAt ? info.lastUsedAt.toISOString() : null,
        retiredAt: question?.retiredAt ? question.retiredAt.toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      // tie-break: most recently used first
      const aLast = a.lastUsedAt ?? "";
      const bLast = b.lastUsedAt ?? "";
      return bLast.localeCompare(aLast);
    })
    .slice(0, TOP_QUESTION_LIMIT);

  // hourly + busiest
  const hourly = buildHourly(
    sessionsByStart.map((s) => s.startedAt),
    messages.map((m) => m.createdAt),
  );
  const busiest = findBusiest(hourly, perDay);

  // booth breakdown (only when >1 booth has data in the window)
  const boothCalls = new Map<string, { calls: number; lastSeenAt: Date | null }>();
  for (const session of sessionsByStart) {
    const existing = boothCalls.get(session.boothId) ?? { calls: 0, lastSeenAt: null };
    existing.calls += 1;
    const candidate = session.endedAt ?? session.startedAt;
    if (!existing.lastSeenAt || candidate > existing.lastSeenAt) {
      existing.lastSeenAt = candidate;
    }
    boothCalls.set(session.boothId, existing);
  }
  const boothBreakdown =
    boothCalls.size > 1
      ? Array.from(boothCalls.entries())
          .map(([boothId, info]) => ({
            boothId,
            calls: info.calls,
            messages: null, // Message has no boothId; documented limitation.
            lastSeenAt: info.lastSeenAt ? info.lastSeenAt.toISOString() : null,
          }))
          .sort((a, b) => b.calls - a.calls)
      : [];

  return {
    window,
    rangeStart: rangeStart ? rangeStart.toISOString() : null,
    rangeEnd: rangeEnd.toISOString(),
    generatedAt: generatedAt.toISOString(),
    timezone: "UTC",
    calls: {
      total: sessionsByStart.length,
      completed: callsCompleted,
      inProgress: inProgressCount,
      averageDurationMs,
      longestDurationMs,
      outcomes,
      perDay,
    },
    messages: {
      total: messages.length,
      byStatus,
      averageDurationMs: messagesAverageDurationMs,
    },
    playback: {
      totalPlaybacks,
    },
    pickupsHangups: {
      pickups: sessionsByStart.length,
      hangups,
      digitsDialed,
    },
    uploads: {
      succeeded: uploadSucceeded,
      failed: uploadFailed,
      failureRate: uploadFailureRate,
    },
    topQuestions,
    hourly,
    busiest,
    lastActivityAt: latestEvent?.receivedAt ? latestEvent.receivedAt.toISOString() : null,
    boothBreakdown,
  };
};

const getCachedOverview = async (window: StatsWindow): Promise<StatsOverview> => {
  const now = Date.now();
  const cachedEntry = overviewCache.get(window);
  if (cachedEntry && cachedEntry.expiresAt > now) return cachedEntry.value;
  const value = await computeStatsOverview(window);
  overviewCache.set(window, { value, expiresAt: now + OVERVIEW_CACHE_TTL_MS });
  return value;
};

export const statsRouter = new Hono<{ Variables: AuthVariables }>();

statsRouter.get("/summary", requireOperator(), async (c) => {
  const summary = await getCachedSummary();
  return c.json(summary);
});

statsRouter.get("/overview", requireOperator(), async (c) => {
  const raw = c.req.query("window") ?? "7d";
  const parsed = StatsWindowSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_window",
        allowed: STATS_WINDOW_VALUES,
      },
      400,
    );
  }
  const overview = await getCachedOverview(parsed.data);
  return c.json(overview);
});
