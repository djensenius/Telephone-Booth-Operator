import { zValidator } from "@hono/zod-validator";
import { MonitorSummarySchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { db } from "../lib/db.js";
import { summarizeInteractionBreakdown } from "../lib/interaction-analytics.js";
import { resolveInstallationScope, scopeWhere } from "../lib/installation.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { DEFAULT_TIME_ZONE, IanaTimeZoneSchema, startOfDayInTimeZone } from "../lib/time-zone.js";

const querySchema = z.object({
  timeZone: IanaTimeZoneSchema.default(DEFAULT_TIME_ZONE),
});

export const monitorRouter = new Hono<{ Variables: ApiTokenVariables }>();

monitorRouter.get(
  "/summary",
  requireApiToken("monitor"),
  zValidator("query", querySchema),
  async (c) => {
    const { timeZone } = c.req.valid("query");
    const generatedAt = new Date();
    const dayStartedAt = startOfDayInTimeZone(generatedAt, timeZone);
    const scoped = scopeWhere(await resolveInstallationScope(undefined));
    const [todaySessions, todayActionEvents, messagesToday, callsTotal, messagesTotal] =
      await db.$transaction(
        (tx) =>
          Promise.all([
            tx.callSession.findMany({
              where: { ...scoped, startedAt: { gte: dayStartedAt } },
            }) as unknown as Promise<
              Array<{
                startedAt: Date;
                endedAt: Date | null;
                outcome: string | null;
                durationMs: number | null;
                digitsDialed: string | null;
              }>
            >,
            tx.boothEvent.findMany({
              where: {
                ...scoped,
                occurredAt: { gte: dayStartedAt },
                type: { in: ["digit_dialed", "state_transition"] },
              },
            }) as unknown as Promise<Array<{ type: string; payload: unknown }>>,
            tx.message.count({ where: { ...scoped, receivedAt: { gte: dayStartedAt } } }),
            tx.callSession.count({ where: scoped }),
            tx.message.count({ where: { ...scoped, receivedAt: { not: null } } }),
          ]),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    const interactionsToday = todaySessions.length;
    const breakdownToday = summarizeInteractionBreakdown(todaySessions, todayActionEvents);

    return c.json(
      MonitorSummarySchema.parse({
        interactionsToday,
        interactionsTotal: callsTotal,
        callsToday: interactionsToday,
        messagesToday,
        callsTotal,
        messagesTotal,
        breakdownToday,
        dayStartedAt: dayStartedAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        timeZone,
      }),
    );
  },
);
