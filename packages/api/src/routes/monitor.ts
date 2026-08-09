import { zValidator } from "@hono/zod-validator";
import { MonitorSummarySchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import { resolveInstallationScope, scopeWhere } from "../lib/installation.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { isValidTimeZone, startOfDayInTimeZone } from "../lib/time-zone.js";

const querySchema = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, "timeZone must be a valid IANA time zone.")
    .default("America/Toronto"),
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
    const [callsToday, messagesToday] = await Promise.all([
      db.callSession.count({ where: { ...scoped, startedAt: { gte: dayStartedAt } } }),
      db.message.count({ where: { ...scoped, receivedAt: { gte: dayStartedAt } } }),
    ]);

    return c.json(
      MonitorSummarySchema.parse({
        callsToday,
        messagesToday,
        dayStartedAt: dayStartedAt.toISOString(),
        generatedAt: generatedAt.toISOString(),
        timeZone,
      }),
    );
  },
);
