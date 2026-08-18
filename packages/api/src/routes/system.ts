// Live system snapshot endpoints. The booth pushes one PUT every ~5s; the
// operator UI reads the latest via GET (or via the status WS envelope).
// Postgres holds one current row per booth so reads work across API replicas.
// VictoriaMetrics remains the owner of historical metrics.

import { zValidator } from "@hono/zod-validator";
import {
  BoothSystemSnapshotSchema,
  BOOTH_CLIENT_VERSION_MAX,
  ThermalHistoryQuerySchema,
  ThermalHistorySchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { queryThermalHistory } from "../lib/grafana-prometheus.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { requireOperatorOrApiToken, type AuthVariables } from "../lib/session.js";
import type { Prisma } from "../generated/prisma/client.js";

const putBodySchema = z.object({
  boothId: z.string().min(1).max(64),
  snapshot: BoothSystemSnapshotSchema,
  // Optional booth-client version (e.g. `0.3.2`). Echoed back on the WS
  // envelope and surfaced in the operator UI's "Live system" panel.
  version: z.string().min(1).max(BOOTH_CLIENT_VERSION_MAX).nullable().optional(),
});

type ThermalSourceRow = {
  boothId: string;
  componentId: string;
  displayName: string;
  kind: string;
  prometheusJob: string;
  prometheusInstance: string;
};

const thermalSourceMetadata = (source: ThermalSourceRow) => ({
  boothId: source.boothId,
  componentId: source.componentId,
  displayName: source.displayName,
  kind: source.kind,
  prometheusJob: source.prometheusJob,
  prometheusInstance: source.prometheusInstance,
});

const systemRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

systemRouter.put("/", requireApiToken(), zValidator("json", putBodySchema), async (c) => {
  const { boothId, snapshot, version } = c.req.valid("json");
  const receivedAt = new Date();
  await db.boothSystemSnapshot.upsert({
    where: { boothId },
    create: {
      boothId,
      snapshot: snapshot as Prisma.InputJsonValue,
      receivedAt,
      version: version ?? null,
    },
    update: {
      snapshot: snapshot as Prisma.InputJsonValue,
      receivedAt,
      version: version ?? null,
    },
  });
  const receivedAtIso = receivedAt.toISOString();
  wsBroadcaster.broadcast({
    kind: "system",
    boothId,
    snapshot,
    receivedAt: receivedAtIso,
    version: version ?? null,
  });
  return c.body(null, 204);
});

systemRouter.get(
  "/current",
  requireOperatorOrApiToken(["operator", "monitor"]),
  zValidator("query", z.object({ boothId: z.string().min(1).optional() })),
  async (c) => {
    const { boothId } = c.req.valid("query");
    if (boothId) {
      const current = await db.boothSystemSnapshot.findUnique({ where: { boothId } });
      if (!current) return c.json({ error: "not_found" }, 404);
      return c.json({
        boothId: current.boothId,
        snapshot: BoothSystemSnapshotSchema.parse(current.snapshot),
        receivedAt: current.receivedAt.toISOString(),
        version: current.version,
      });
    }
    const rows = await db.boothSystemSnapshot.findMany({ orderBy: { boothId: "asc" } });
    return c.json({
      items: rows.map((current) => ({
        boothId: current.boothId,
        snapshot: BoothSystemSnapshotSchema.parse(current.snapshot),
        receivedAt: current.receivedAt.toISOString(),
        version: current.version,
      })),
    });
  },
);

systemRouter.get("/thermals/history", zValidator("query", ThermalHistoryQuerySchema), async (c) => {
  const { boothId, componentId, from, to, stepSeconds } = c.req.valid("query");
  const source = await (async () => {
    if (componentId) {
      return db.telemetrySource.findUnique({
        where: { boothId_componentId: { boothId, componentId } },
      });
    }
    const sources = await db.telemetrySource.findMany({
      where: { boothId },
      orderBy: [{ componentId: "asc" }, { id: "asc" }],
    });
    return sources.find((candidate) => candidate.componentId === "router") ?? sources[0];
  })();
  if (!source) return c.json({ error: "telemetry_source_not_found" }, 404);

  const normalizedFrom = new Date(from).toISOString();
  const normalizedTo = new Date(to).toISOString();
  const history = await queryThermalHistory({
    boothId,
    prometheusJob: source.prometheusJob,
    prometheusInstance: source.prometheusInstance,
    from: normalizedFrom,
    to: normalizedTo,
    stepSeconds,
  });
  if (!history.ok) {
    return c.json(
      {
        error:
          history.reason === "not_configured"
            ? "telemetry_history_not_configured"
            : "telemetry_history_upstream",
      },
      history.reason === "not_configured" ? 503 : 502,
    );
  }

  return c.json(
    ThermalHistorySchema.parse({
      boothId,
      source: thermalSourceMetadata(source),
      from: normalizedFrom,
      to: normalizedTo,
      stepSeconds,
      series: history.series,
    }),
  );
});

export { systemRouter };
