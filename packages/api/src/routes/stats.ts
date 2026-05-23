// Aggregated booth status + queue counters for mobile widgets / dashboards.
// Results are memoized for STATS_CACHE_TTL_MS so that high-frequency widget
// timelines don't fan out into N Postgres queries per refresh.

import { Hono } from "hono";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { defaultStatus, serializeStatus } from "../lib/serializers.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

const STATS_CACHE_TTL_MS = 5_000;

type StatsSummary = {
  booth: ReturnType<typeof serializeStatus>;
  messages: {
    pending: number;
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

  const [latestStatus, pendingCount, receivedToday, latestMessage, callsToday, callsInProgress] =
    await Promise.all([
      db.boothStatusSnapshot.findFirst({ orderBy: { updatedAt: "desc" } }),
      db.message.count({ where: { status: "pending" } }),
      db.message.count({ where: { createdAt: { gte: startOfDay } } }),
      db.message.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } }),
      db.callSession.count({ where: { startedAt: { gte: startOfDay } } }),
      db.callSession.count({ where: { endedAt: null } }),
    ]);

  return {
    booth: latestStatus ? serializeStatus(latestStatus) : defaultStatus(),
    messages: {
      pending: pendingCount,
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
};

export const statsRouter = new Hono<{ Variables: AuthVariables }>();

statsRouter.get("/summary", requireOperator(), async (c) => {
  const summary = await getCachedSummary();
  return c.json(summary);
});
