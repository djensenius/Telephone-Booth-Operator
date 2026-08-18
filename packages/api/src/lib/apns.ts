// APNs sender abstraction.
//
// The production environment provides APNS_TEAM_ID, APNS_KEY_ID,
// APNS_AUTH_KEY (a PEM-encoded ES256 .p8 key), APNS_BUNDLE_ID, and
// optionally APNS_ENVIRONMENT ("development" | "production"). When any
// of those are missing, the sender is a no-op — useful for local dev
// and tests where no real APNs traffic should leave the box.
//
// The sender is intentionally split from the device registry so we can
// stub it in tests and add other transports (FCM for an Android port,
// for example) without disturbing the route handlers.

import { db } from "./db.js";
import { Http2ApnsSender, inspectApnsConfig, loadApnsConfigFromEnv } from "./apns-http2.js";
import { log } from "./logger.js";
import type { MobileDevicePreferences } from "@telephone-booth-operator/shared";

type ApnsAlertNotification = {
  kind: "alert";
  /// One of the keys in `MobileDevicePreferences` — the per-device
  /// notification toggle that gates delivery.
  preferenceKey: keyof MobileDevicePreferences;
  /// Alert title shown on the lock screen / banner.
  title: string;
  /// Alert body.
  body: string;
  /// Optional category for action-button rendering.
  category?: string;
  /// Optional thread identifier so iOS coalesces related alerts.
  threadId?: string;
  /// Custom payload merged with the standard `aps` envelope.
  data?: Record<string, unknown>;
};

export type ApnsBadgeNotification = {
  kind: "badge";
  /// Badge-only pushes go to every active device, independently of alert
  /// preferences, so the count stays accurate when banners are disabled.
  badge: number;
  /// Custom payload merged with the standard `aps` envelope.
  data?: Record<string, unknown>;
};

export type ApnsNotification = ApnsAlertNotification | ApnsBadgeNotification;

export type ApnsDeliveryFence = () => Promise<Date | null>;

export type ApnsSender = {
  send(
    userId: string,
    notification: ApnsNotification,
    beforeSubmit?: ApnsDeliveryFence,
  ): Promise<void>;
};

class NoopApnsSender implements ApnsSender {
  send(
    _userId: string,
    _notification: ApnsNotification,
    _beforeSubmit?: ApnsDeliveryFence,
  ): Promise<void> {
    // APNs is not configured. Resolve to satisfy the interface but skip
    // the network round-trip. Tests can inject a spy via
    // `setApnsSenderForTests`.
    return Promise.resolve();
  }
}

const noopSender = new NoopApnsSender();
let testSender: ApnsSender | null = null;
let productionSender: ApnsSender | null = null;

export const isApnsDeliveryConfigured = (): boolean =>
  testSender !== null || loadApnsConfigFromEnv() !== null;

export const setApnsSenderForTests = (sender: ApnsSender): void => {
  testSender = sender;
};

export const resetApnsSenderForTests = (): void => {
  testSender = null;
};

/// Resolves the active sender. In production this returns the real
/// HTTP/2-backed implementation (lazily constructed from the environment);
/// in tests it returns whatever was set via `setApnsSenderForTests`, and in
/// dev (no APNs env) it returns the no-op stub.
export const apnsSender = (): ApnsSender => {
  if (testSender) return testSender;
  if (productionSender) return productionSender;
  const config = loadApnsConfigFromEnv();
  if (config) {
    productionSender = new Http2ApnsSender(config);
    return productionSender;
  }
  return noopSender;
};

/// Looks up active devices for `userId`. Alert pushes honor the given
/// preference key; a null key selects every active device for badge sync.
export const findTargetDevices = async (
  userId: string,
  preferenceKey: keyof MobileDevicePreferences | null,
): Promise<Array<{ id: string; apnsToken: string; platform: string }>> => {
  const devices = await db.mobileDevice.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, apnsToken: true, platform: true, preferences: true },
  });
  return devices
    .filter(
      (device) => preferenceKey === null || prefersNotification(device.preferences, preferenceKey),
    )
    .map(({ id, apnsToken, platform }) => ({ id, apnsToken, platform }));
};

const prefersNotification = (raw: unknown, key: keyof MobileDevicePreferences): boolean => {
  const defaults: MobileDevicePreferences = {
    callStarted: true,
    messageReceived: true,
    messageFlagged: true,
    moderationQueueHigh: false,
  };
  if (raw && typeof raw === "object") {
    const candidate = (raw as Record<string, unknown>)[key];
    if (typeof candidate === "boolean") return candidate;
  }
  return defaults[key];
};

const sendToOperatorUsers = async (
  notification: ApnsNotification,
  beforeSubmit?: ApnsDeliveryFence,
): Promise<{ userIds: string[]; results: PromiseSettledResult<void>[] }> => {
  const userIds = await db.mobileDevice
    .findMany({
      where: { revokedAt: null },
      select: { userId: true },
      distinct: ["userId"],
    })
    .then((rows) => Array.from(new Set(rows.map((row) => row.userId))));
  const results = await Promise.allSettled(
    userIds.map((userId) => apnsSender().send(userId, notification, beforeSubmit)),
  );
  return { userIds, results };
};

/// Fan-out: send `notification` to every device for every operator user
/// that has the preference enabled. Used by the events broadcaster when
/// it sees a notable event.
///
/// All errors are swallowed: this is a best-effort, fire-and-forget path
/// invoked from request handlers that must not fail if APNs (or the
/// mobile_devices table) is unavailable.
export const fanOutNotification = async (notification: ApnsNotification): Promise<void> => {
  if (!isApnsDeliveryConfigured()) return;
  const preferenceKey = notification.kind === "alert" ? notification.preferenceKey : undefined;
  try {
    const { userIds, results } = await sendToOperatorUsers(notification);
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      log.error(
        {
          component: "apns",
          errorName: result.reason instanceof Error ? result.reason.name : "unknown",
          notificationKind: notification.kind,
          ...(preferenceKey === undefined ? {} : { preferenceKey }),
          userId: userIds[index],
        },
        "APNs sender rejected fan-out",
      );
    }
  } catch (error) {
    log.error(
      {
        component: "apns",
        err: error,
        notificationKind: notification.kind,
        ...(preferenceKey === undefined ? {} : { preferenceKey }),
      },
      "APNs fan-out failed",
    );
    // Push delivery is best-effort. Never let a failure here surface
    // to the request handler.
  }
};

/// Reliable fan-out for durable badge delivery. Unlike alert fan-out, database
/// and sender failures propagate so the dispatcher can retain and retry the
/// pending badge version.
export const fanOutBadgeNotification = async (
  notification: ApnsBadgeNotification,
  beforeSubmit?: ApnsDeliveryFence,
): Promise<void> => {
  if (!isApnsDeliveryConfigured()) return;

  const { results } = await sendToOperatorUsers(notification, beforeSubmit);
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error("APNs sender rejected badge fan-out", { cause: result.reason }),
        ]
      : [],
  );
  if (failures.length > 0) {
    const target = failures.length === 1 ? "user" : "users";
    throw new AggregateError(
      failures,
      `APNs badge fan-out failed for ${failures.length} ${target}`,
    );
  }
};

export const apnsHealthStatus = async (): Promise<{
  status: "configured" | "disabled" | "misconfigured";
  environment: "production" | "development" | null;
  missing?: string[];
  invalid?: string[];
}> => {
  const status = await inspectApnsConfig();
  if (status.status === "configured") {
    return { status: status.status, environment: status.environment };
  }
  return {
    status: status.status,
    environment: status.environment,
    ...(status.missing.length > 0 ? { missing: status.missing } : {}),
    ...(status.invalid.length > 0 ? { invalid: status.invalid } : {}),
  };
};

export const logApnsConfiguration = async (): Promise<void> => {
  const status = await apnsHealthStatus();
  const fields = { component: "apns", ...status };
  if (status.status === "configured") {
    log.info(fields, "APNs configured");
  } else if (status.status === "misconfigured") {
    log.error(fields, "APNs configuration is incomplete or invalid; push delivery disabled");
  } else if (process.env.NODE_ENV === "production") {
    log.error(fields, "APNs is not configured in production; push delivery disabled");
  } else {
    log.warn(fields, "APNs is not configured; push delivery disabled");
  }
};
