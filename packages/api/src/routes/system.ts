// Live system snapshot endpoints. The booth pushes one PUT every ~5s; the
// operator UI reads the latest via GET (or via the status WS envelope).
// No Postgres persistence in v1 — VictoriaMetrics owns historical metrics.

import { zValidator } from "@hono/zod-validator";
import { BoothSystemSnapshotSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import { getSystemSnapshot, listSystemSnapshots, setSystemSnapshot } from "../lib/system-cache.js";
import { requireOperator, type AuthVariables } from "../lib/session.js";

const putBodySchema = z.object({
  boothId: z.string().min(1).max(64),
  snapshot: BoothSystemSnapshotSchema,
});

const systemRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

systemRouter.put("/", requireApiToken(), zValidator("json", putBodySchema), (c) => {
  const { boothId, snapshot } = c.req.valid("json");
  const receivedAt = new Date().toISOString();
  setSystemSnapshot({ boothId, snapshot, receivedAt });
  wsBroadcaster.broadcast({ kind: "system", boothId, snapshot, receivedAt });
  return c.body(null, 204);
});

systemRouter.get(
  "/current",
  requireOperator(),
  zValidator("query", z.object({ boothId: z.string().min(1).optional() })),
  (c) => {
    const { boothId } = c.req.valid("query");
    if (boothId) {
      const cached = getSystemSnapshot(boothId);
      if (!cached) return c.json({ error: "not_found" }, 404);
      return c.json(cached);
    }
    return c.json({ items: listSystemSnapshots() });
  },
);

export { systemRouter };
