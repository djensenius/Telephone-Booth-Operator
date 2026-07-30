// Aggregated booth status + queue counters for mobile widgets / dashboards.
// Results are memoized for STATS_CACHE_TTL_MS so that high-frequency widget
// timelines don't fan out into N Postgres queries per refresh.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  InstallationScopeSchema,
  MetricFilterCreateSchema,
  MetricFilterUpdateSchema,
  StatsWindowSchema,
  statsWindowDurationMs,
  type MetricFilter,
  type StatsOverview,
  type StatsWindow,
} from "@telephone-booth-operator/shared";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { countMessagesAwaitingModeration } from "../lib/moderation-badge.js";
import {
  resolveInstallationScope,
  scopeCacheKey,
  scopeWhere,
  type InstallationScopeFilter,
} from "../lib/installation.js";
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

// Keyed by installation scope so a rollover doesn't serve the previous era's
// numbers for the rest of the cache TTL.
const summaryCache = new Map<string, { value: StatsSummary; expiresAt: number }>();

const computeStatsSummary = async (scope: InstallationScopeFilter): Promise<StatsSummary> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const scoped = scopeWhere(scope);

  const [
    latestStatus,
    pendingCount,
    awaitingModeration,
    receivedToday,
    latestMessage,
    callsToday,
    callsInProgress,
  ] = await Promise.all([
    // Same tie-break as `/v1/status` so both report the same current row when
    // two booth-supplied timestamps collide.
    db.boothStatusSnapshot.findFirst({
      where: scoped,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    db.message.count({ where: { ...scoped, status: "pending" } }),
    countMessagesAwaitingModeration(scoped),
    db.message.count({ where: { ...scoped, createdAt: { gte: startOfDay } } }),
    db.message.findFirst({
      where: scoped,
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    db.callSession.count({ where: { ...scoped, startedAt: { gte: startOfDay } } }),
    db.callSession.count({ where: { ...scoped, endedAt: null } }),
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

// The cache key carries a caller-supplied installation id, so an operator
// asking for era after era would otherwise grow these maps without bound. Drop
// expired entries on write, and cap what is left: they are a latency
// optimisation for the handful of scopes a console actually looks at.
const CACHE_MAX_ENTRIES = 64;

const cachePut = <T>(
  cache: Map<string, { value: T; expiresAt: number }>,
  key: string,
  value: T,
  ttlMs: number,
): void => {
  const now = Date.now();
  for (const [existing, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(existing);
  }
  cache.set(key, { value, expiresAt: now + ttlMs });
  // Insertion order: the oldest live entry goes first.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
};

const getCachedSummary = async (scope: InstallationScopeFilter): Promise<StatsSummary> => {
  const now = Date.now();
  const key = scopeCacheKey(scope);
  const entry = summaryCache.get(key);
  if (entry && entry.expiresAt > now) return entry.value;
  const value = await computeStatsSummary(scope);
  cachePut(summaryCache, key, value, STATS_CACHE_TTL_MS);
  return value;
};

// Cache occupancy, so a test can prove the bound actually holds.
export const statsCacheSizesForTests = (): { summary: number; overview: number } => ({
  summary: summaryCache.size,
  overview: overviewCache.size,
});

export const resetStatsCacheForTests = (): void => {
  summaryCache.clear();
  overviewCache.clear();
};

// -----------------------------------------------------------------------------
// /v1/stats/overview — historical aggregation across calls, messages, booth
// events. Aggregation is done in JS over `findMany` results (no $queryRaw)
// to keep the route trivially testable against the in-memory fake-db; the
// row counts on a real installation are small enough that this is fine.
// -----------------------------------------------------------------------------

const overviewCache = new Map<string, { value: StatsOverview; expiresAt: number }>();

// A resolved time selection for the overview aggregation. `window` is the
// label echoed back to the client ("custom" for explicit ranges). `rangeStart`
// is the inclusive lower bound (null = from the beginning) and `rangeEnd` is
// the inclusive upper bound (defaults to "now" for presets).
type ResolvedRange = {
  window: StatsWindow | "custom";
  rangeStart: Date | null;
  rangeEnd: Date;
};

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

const buildHourly = (callTimes: Date[], messageTimes: Date[]): StatsOverview["hourly"] => {
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

const computeStatsOverview = async (
  range: ResolvedRange,
  scope: InstallationScopeFilter,
): Promise<StatsOverview> => {
  const scoped = scopeWhere(scope);
  const generatedAt = new Date();
  const { window, rangeStart, rangeEnd } = range;
  // Inclusive bounds. Presets have rangeEnd == now, so the upper bound is a
  // no-op there; custom ranges may end in the past, hence the explicit `lte`.
  const bounds: { gte?: Date; lte: Date } = { lte: rangeEnd };
  if (rangeStart) bounds.gte = rangeStart;

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
      where: { ...scoped, startedAt: bounds },
    }) as unknown as Promise<CallSessionRow[]>,
    db.callSession.findMany({
      where: { ...scoped, endedAt: bounds, outcome: { not: null } },
    }) as unknown as Promise<CallSessionRow[]>,
    // Used for the pickup/hangup panel — counts sessions whose endedAt fell
    // inside the window regardless of outcome, so the panel reconciles with
    // calls.* at window boundaries (a call that started before the window
    // but hung up inside it still counts as one hangup here).
    db.callSession.count({
      where: { ...scoped, endedAt: bounds },
    }),
    db.callSession.count({ where: { ...scoped, endedAt: null } }),
    db.message.findMany({
      where: { ...scoped, createdAt: bounds },
      include: { audio: true },
      take: MAX_MESSAGES_PER_OVERVIEW,
    }) as unknown as Promise<MessageRow[]>,
    db.boothEvent.findMany({
      where: { ...scoped, type: "state_transition", occurredAt: bounds },
    }) as unknown as Promise<BoothEventRow[]>,
    db.boothEvent.findMany({
      where: { ...scoped, type: { in: ["upload_completed", "upload_failed"] }, occurredAt: bounds },
    }) as unknown as Promise<BoothEventRow[]>,
    db.boothEvent.findFirst({
      where: scoped,
      orderBy: [{ receivedAt: "desc" }],
    }) as unknown as Promise<{ receivedAt: Date } | null>,
    db.question.findMany({ where: scoped }) as unknown as Promise<
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
  //
  // A straggler recording is filed in the era that was open when it landed
  // while its question stays in the era that issued it, so resolving prompts
  // from the scoped questions alone would label those "(deleted question)".
  // Anything the scoped messages reference is looked up by id as well.
  const referencedQuestionIds = [
    ...new Set(
      messages
        .map((message) => message.questionId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].filter((id) => !questions.some((question) => question.id === id));
  const referenced =
    referencedQuestionIds.length > 0
      ? ((await db.question.findMany({
          where: { id: { in: referencedQuestionIds } },
        })) as unknown as Array<{
          id: string;
          prompt: string;
          retiredAt: Date | null;
        }>)
      : [];
  const questionsById = new Map([...questions, ...referenced].map((q) => [q.id, q]));
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

// Resolve a preset window into a concrete range ending "now".
const presetRange = (window: StatsWindow): ResolvedRange => {
  const rangeEnd = new Date();
  const windowMs = statsWindowDurationMs(window);
  const rangeStart = windowMs === null ? null : new Date(rangeEnd.getTime() - windowMs);
  return { window, rangeStart, rangeEnd };
};

const getCachedOverview = async (
  window: StatsWindow,
  scope: InstallationScopeFilter,
): Promise<StatsOverview> => {
  const now = Date.now();
  const key = `${window}:${scopeCacheKey(scope)}`;
  const cachedEntry = overviewCache.get(key);
  if (cachedEntry && cachedEntry.expiresAt > now) return cachedEntry.value;
  const value = await computeStatsOverview(presetRange(window), scope);
  cachePut(overviewCache, key, value, OVERVIEW_CACHE_TTL_MS);
  return value;
};

// Query schema for /overview. Either a preset `window`, or a custom range via
// `start`/`end`. `end` accepts the literal "now" (or is omitted) to mean the
// current instant, so a saved custom filter stays live.
const overviewQuerySchema = z
  .object({
    window: StatsWindowSchema.optional(),
    start: z.string().datetime().optional(),
    end: z.union([z.literal("now"), z.string().datetime()]).optional(),
    installationId: InstallationScopeSchema.optional(),
  })
  .refine(
    (v) => (v.start && v.end && v.end !== "now" ? new Date(v.start) <= new Date(v.end) : true),
    {
      message: "start must be on or before end",
      path: ["start"],
    },
  );

const resolveOverviewRange = (query: z.infer<typeof overviewQuerySchema>): ResolvedRange => {
  const hasCustom = query.start !== undefined || query.end !== undefined;
  if (!hasCustom) return presetRange(query.window ?? "7d");
  const rangeEnd = !query.end || query.end === "now" ? new Date() : new Date(query.end);
  const rangeStart = query.start ? new Date(query.start) : null;
  return { window: "custom", rangeStart, rangeEnd };
};

// -----------------------------------------------------------------------------
// Saved metric filters — per-operator named time selections. Owner-scoped: an
// operator only ever sees and mutates their own filters.
// -----------------------------------------------------------------------------

type MetricFilterRow = {
  id: string;
  name: string;
  window: string | null;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const serializeMetricFilter = (row: MetricFilterRow): MetricFilter => ({
  id: row.id,
  name: row.name,
  window: (row.window as StatsWindow | null) ?? null,
  start: row.rangeStart ? row.rangeStart.toISOString() : null,
  end: row.rangeEnd ? row.rangeEnd.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const idParamSchema = z.object({ id: z.guid() });

export const statsRouter = new Hono<{ Variables: AuthVariables }>();

const scopeQuerySchema = z.object({ installationId: InstallationScopeSchema.optional() });

statsRouter.get("/summary", requireOperator(), zValidator("query", scopeQuerySchema), async (c) => {
  const scope = await resolveInstallationScope(c.req.valid("query").installationId);
  const summary = await getCachedSummary(scope);
  return c.json(summary);
});

statsRouter.get(
  "/overview",
  requireOperator(),
  zValidator("query", overviewQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const range = resolveOverviewRange(query);
    const scope = await resolveInstallationScope(query.installationId);
    // Preset windows are cached; custom ranges (which may end at a live "now")
    // are computed fresh so the numbers are always current.
    const overview =
      range.window === "custom"
        ? await computeStatsOverview(range, scope)
        : await getCachedOverview(range.window, scope);
    return c.json(overview);
  },
);

statsRouter.get("/filters", requireOperator(), async (c) => {
  const user = c.get("user");
  const rows = (await db.metricFilter.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "asc" }],
  })) as unknown as MetricFilterRow[];
  return c.json({ items: rows.map(serializeMetricFilter) });
});

statsRouter.post(
  "/filters",
  requireOperator(),
  zValidator("json", MetricFilterCreateSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const row = (await db.metricFilter.create({
      data: {
        userId: user.id,
        name: body.name,
        window: body.window ?? null,
        rangeStart: body.start ? new Date(body.start) : null,
        rangeEnd: body.end ? new Date(body.end) : null,
      },
    })) as unknown as MetricFilterRow;
    return c.json(serializeMetricFilter(row), 201);
  },
);

statsRouter.get(
  "/filters/:id",
  requireOperator(),
  zValidator("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const existing = await db.metricFilter.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== user.id) return c.json({ error: "not_found" }, 404);
    return c.json(serializeMetricFilter(existing));
  },
);

statsRouter.put(
  "/filters/:id",
  requireOperator(),
  zValidator("param", idParamSchema),
  zValidator("json", MetricFilterUpdateSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = (await db.metricFilter.findUnique({
      where: { id },
    })) as unknown as MetricFilterRow & { userId: string };
    if (!existing || existing.userId !== user.id) return c.json({ error: "not_found" }, 404);
    const row = (await db.metricFilter.update({
      where: { id },
      data: {
        name: body.name,
        window: body.window ?? null,
        rangeStart: body.start ? new Date(body.start) : null,
        rangeEnd: body.end ? new Date(body.end) : null,
      },
    })) as unknown as MetricFilterRow;
    return c.json(serializeMetricFilter(row));
  },
);

statsRouter.delete(
  "/filters/:id",
  requireOperator(),
  zValidator("param", idParamSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const existing = (await db.metricFilter.findUnique({
      where: { id },
    })) as unknown as { userId: string } | null;
    if (!existing || existing.userId !== user.id) return c.json({ error: "not_found" }, 404);
    await db.metricFilter.delete({ where: { id } });
    return c.body(null, 204);
  },
);
