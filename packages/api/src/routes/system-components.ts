import { zValidator } from "@hono/zod-validator";
import {
  ComponentTelemetryCurrentQuerySchema,
  ComponentTelemetryHistoryQuerySchema,
  ComponentTelemetryHistorySchema,
  RouterComponentSnapshotSchema,
  RouterComponentSnapshotUpdateSchema,
  TelemetrySourceEnvelopeSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Prisma } from "../generated/prisma/client.js";
import { db } from "../lib/db.js";
import { queryRouterTelemetryHistory } from "../lib/grafana-prometheus.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";

export const COMPONENT_TELEMETRY_MAX_REQUEST_BYTES = 64 * 1024;

type TelemetrySourceRow = {
  id: string;
  boothId: string;
  componentId: string;
  displayName: string;
  kind: string;
  prometheusJob: string;
  prometheusInstance: string;
  latestSnapshot: unknown;
  capturedAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const sourceMetadata = (source: TelemetrySourceRow) => ({
  boothId: source.boothId,
  componentId: source.componentId,
  displayName: source.displayName,
  kind: source.kind,
  prometheusJob: source.prometheusJob,
  prometheusInstance: source.prometheusInstance,
});

const sourceEnvelope = (source: TelemetrySourceRow) =>
  TelemetrySourceEnvelopeSchema.parse({
    id: source.id,
    ...sourceMetadata(source),
    latestSnapshot:
      source.latestSnapshot === null
        ? null
        : RouterComponentSnapshotSchema.parse(source.latestSnapshot),
    capturedAt: source.capturedAt?.toISOString() ?? null,
    receivedAt: source.receivedAt?.toISOString() ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  });

const componentTelemetryRouter = new Hono<{ Variables: ApiTokenVariables }>();

componentTelemetryRouter.put(
  "/current",
  requireApiToken("telemetry"),
  bodyLimit({
    maxSize: COMPONENT_TELEMETRY_MAX_REQUEST_BYTES,
    onError: (c) =>
      c.json(
        {
          error: "payload_too_large",
          limitBytes: COMPONENT_TELEMETRY_MAX_REQUEST_BYTES,
        },
        413,
      ),
  }),
  zValidator("json", RouterComponentSnapshotUpdateSchema),
  async (c) => {
    const telemetrySourceId = c.get("apiToken").telemetrySourceId;
    if (!telemetrySourceId) {
      return c.json({ error: "telemetry_source_not_bound" }, 403);
    }

    const { capturedAt, snapshot } = c.req.valid("json");
    const incomingCapturedAt = new Date(capturedAt);
    const receivedAt = new Date();
    const updated = await db.telemetrySource.updateMany({
      where: {
        id: telemetrySourceId,
        OR: [{ capturedAt: null }, { capturedAt: { lte: incomingCapturedAt } }],
      },
      data: {
        latestSnapshot: snapshot as Prisma.InputJsonValue,
        capturedAt: incomingCapturedAt,
        receivedAt,
      },
    });
    if (updated.count === 0) {
      const source = await db.telemetrySource.findUnique({
        where: { id: telemetrySourceId },
        select: { id: true },
      });
      if (!source) return c.json({ error: "telemetry_source_not_bound" }, 403);
    }
    return c.body(null, 204);
  },
);

componentTelemetryRouter.get(
  "/current",
  zValidator("query", ComponentTelemetryCurrentQuerySchema),
  async (c) => {
    const { boothId, componentId } = c.req.valid("query");
    const sources = await db.telemetrySource.findMany({
      where: {
        ...(boothId ? { boothId } : {}),
        ...(componentId ? { componentId } : {}),
      },
      orderBy: [{ boothId: "asc" }, { componentId: "asc" }],
    });
    return c.json(sources.map(sourceEnvelope));
  },
);

componentTelemetryRouter.get(
  "/history",
  zValidator("query", ComponentTelemetryHistoryQuerySchema),
  async (c) => {
    const { boothId, componentId, from, to, stepSeconds } = c.req.valid("query");
    const source = await db.telemetrySource.findUnique({
      where: { boothId_componentId: { boothId, componentId } },
    });
    if (!source) return c.json({ error: "telemetry_source_not_found" }, 404);

    const normalizedFrom = new Date(from).toISOString();
    const normalizedTo = new Date(to).toISOString();
    const history = await queryRouterTelemetryHistory({
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
      ComponentTelemetryHistorySchema.parse({
        source: sourceMetadata(source),
        from: normalizedFrom,
        to: normalizedTo,
        stepSeconds,
        series: history.series,
      }),
    );
  },
);

export { componentTelemetryRouter };
