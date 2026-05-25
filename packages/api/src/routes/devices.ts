// Mobile device registry — APNs token storage + per-device notification
// preferences for the operator mobile app. Devices are owned by the
// authenticated operator user; the table has no cross-user lookups
// (each user only sees / mutates their own rows).

import { zValidator } from "@hono/zod-validator";
import {
  MobileDeviceSchema,
  MobileDevicePreferencesSchema,
  RegisterMobileDeviceRequestSchema,
  UpdateMobileDevicePreferencesSchema,
  type MobileDevicePreferences,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import { type AuthVariables } from "../lib/session.js";

const idParam = z.object({ id: z.string().uuid() });

const defaultPreferences: MobileDevicePreferences = {
  callStarted: true,
  messageReceived: true,
  messageFlagged: true,
  moderationQueueHigh: false,
};

const mergePreferences = (
  raw: unknown,
  override: { [K in keyof MobileDevicePreferences]?: boolean | undefined } | undefined,
): MobileDevicePreferences => {
  const parsed = MobileDevicePreferencesSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  const base = parsed.success ? parsed.data : defaultPreferences;
  if (!override) return base;
  return {
    callStarted: override.callStarted ?? base.callStarted,
    messageReceived: override.messageReceived ?? base.messageReceived,
    messageFlagged: override.messageFlagged ?? base.messageFlagged,
    moderationQueueHigh: override.moderationQueueHigh ?? base.moderationQueueHigh,
  };
};

type DeviceRow = {
  id: string;
  apnsToken: string;
  platform: string;
  deviceName: string | null;
  preferences: unknown;
  registeredAt: Date;
  lastSeenAt: Date;
};

const toSummary = (row: DeviceRow) =>
  MobileDeviceSchema.parse({
    id: row.id,
    apnsToken: row.apnsToken,
    platform: row.platform,
    deviceName: row.deviceName,
    preferences: mergePreferences(row.preferences, undefined),
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  });

export const devicesRouter = new Hono<{ Variables: AuthVariables }>()
  .get("/", async (c) => {
    const user = c.get("user");
    const rows = await db.mobileDevice.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { registeredAt: "desc" },
    });
    return c.json(rows.map(toSummary));
  })
  .post("/", zValidator("json", RegisterMobileDeviceRequestSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const preferences = mergePreferences(undefined, body.preferences);
    const row = await db.mobileDevice.upsert({
      where: { apnsToken_platform: { apnsToken: body.apnsToken, platform: body.platform } },
      create: {
        userId: user.id,
        apnsToken: body.apnsToken,
        platform: body.platform,
        deviceName: body.deviceName ?? null,
        preferences,
      },
      update: {
        // If a token re-registers under a different user (re-install on
        // a borrowed device, for example), transfer ownership and reset
        // the revocation flag.
        userId: user.id,
        deviceName: body.deviceName ?? null,
        preferences,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    });
    return c.json(toSummary(row), 201);
  })
  .patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", UpdateMobileDevicePreferencesSchema),
    async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const existing = await db.mobileDevice.findFirst({
        where: { id, userId: user.id, revokedAt: null },
      });
      if (!existing) return c.json({ error: "not_found" }, 404);
      const merged = mergePreferences(existing.preferences, body.preferences);
      const row = await db.mobileDevice.update({
        where: { id },
        data: {
          deviceName:
            body.deviceName === undefined ? existing.deviceName : (body.deviceName ?? null),
          preferences: merged,
          lastSeenAt: new Date(),
        },
      });
      return c.json(toSummary(row));
    },
  )
  .delete("/:id", zValidator("param", idParam), async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const result = await db.mobileDevice.updateMany({
      where: { id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) return c.json({ error: "not_found" }, 404);
    return new Response(null, { status: 204 });
  });

export default devicesRouter;
