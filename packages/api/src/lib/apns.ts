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
import type { MobileDevicePreferences } from "@telephone-booth-operator/shared";

export type ApnsNotification = {
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

export type ApnsSender = {
  send(userId: string, notification: ApnsNotification): Promise<void>;
};

class NoopApnsSender implements ApnsSender {
  send(_userId: string, _notification: ApnsNotification): Promise<void> {
    // APNs is not configured. Resolve to satisfy the interface but skip
    // the network round-trip. Tests can inject a spy via
    // `setApnsSenderForTests`.
    return Promise.resolve();
  }
}

const apnsEnvConfigured = (): boolean =>
  Boolean(process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_AUTH_KEY && process.env.APNS_BUNDLE_ID);

let activeSender: ApnsSender = new NoopApnsSender();
let senderInjectedForTests = false;

export const setApnsSenderForTests = (sender: ApnsSender): void => {
  activeSender = sender;
  senderInjectedForTests = true;
};

export const resetApnsSenderForTests = (): void => {
  activeSender = new NoopApnsSender();
  senderInjectedForTests = false;
};

/// Resolves the active sender. In production this returns the real
/// HTTP/2-backed implementation; in tests / dev it returns the no-op
/// stub or whatever was set via `setApnsSenderForTests`.
export const apnsSender = (): ApnsSender => activeSender;

/// Looks up active devices for `userId` whose preferences enable the
/// given preference key, applies sensible defaults to the preference
/// object, and returns the resulting list.
export const findTargetDevices = async (
  userId: string,
  preferenceKey: keyof MobileDevicePreferences,
): Promise<Array<{ id: string; apnsToken: string; platform: string }>> => {
  const devices = await db.mobileDevice.findMany({
    where: { userId, revokedAt: null },
    select: { id: true, apnsToken: true, platform: true, preferences: true },
  });
  return devices
    .filter((device) => prefersNotification(device.preferences, preferenceKey))
    .map(({ id, apnsToken, platform }) => ({ id, apnsToken, platform }));
};

const prefersNotification = (
  raw: unknown,
  key: keyof MobileDevicePreferences,
): boolean => {
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

/// Fan-out: send `notification` to every device for every operator user
/// that has the preference enabled. Used by the events broadcaster when
/// it sees a notable event.
///
/// All errors are swallowed: this is a best-effort, fire-and-forget path
/// invoked from request handlers that must not fail if APNs (or the
/// mobile_devices table) is unavailable.
export const fanOutNotification = async (notification: ApnsNotification): Promise<void> => {
  if (!apnsEnvConfigured() && !senderInjectedForTests) {
    return;
  }
  try {
    const userIds = await db.mobileDevice
      .findMany({
        where: { revokedAt: null },
        select: { userId: true },
        distinct: ["userId"],
      })
      .then((rows) => Array.from(new Set(rows.map((row) => row.userId))));
    await Promise.allSettled(userIds.map((userId) => apnsSender().send(userId, notification)));
  } catch {
    // Push delivery is best-effort. Never let a failure here surface
    // to the request handler.
  }
};
