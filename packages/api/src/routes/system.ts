// Live system snapshot endpoints. The booth pushes one PUT every ~5s; the
// operator UI reads the latest via GET (or via the status WS envelope).
// Postgres holds one current row per booth so reads work across API replicas.
// VictoriaMetrics remains the owner of historical metrics.

import { zValidator } from "@hono/zod-validator";
import {
  BoothSystemSnapshotSchema,
  BOOTH_CLIENT_VERSION_MAX,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
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

export { systemRouter };
