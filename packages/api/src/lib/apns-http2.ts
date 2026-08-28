// Real APNs transport: ES256 provider-token JWT + HTTP/2 to Apple.
//
// This is split out from `apns.ts` so the payload/JWT builders can be unit
// tested without a live socket, and so `apns.ts` stays a thin policy layer
// (preferences, fan-out, test injection) over whichever transport is active.
//
// Provider authentication tokens are signed with the team's .p8 ES256 key
// and are valid for up to 60 minutes; Apple rejects tokens older than ~1h
// and throttles regenerating them more than once per ~20 minutes, so we
// cache a token and refresh it on a 40-minute cadence.

import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";

import { db } from "./db.js";
import {
  APNS_DELIVERY_FENCE_MINIMUM_MS,
  findTargetDevices,
  type ApnsDeliveryFence,
  type ApnsNotification,
} from "./apns.js";
import { log } from "./logger.js";

type ApnsSigningKey = Awaited<ReturnType<typeof importPKCS8>>;

export type ApnsConfig = {
  teamId: string;
  keyId: string;
  /// PEM-encoded ES256 private key (the contents of the .p8 file).
  authKey: string;
  /// The primary app bundle identifier — used as the default `apns-topic`.
  bundleId: string;
  /// "production" hits api.push.apple.com; anything else uses the sandbox.
  environment: "production" | "development";
};

const PRODUCTION_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";
const JWT_REFRESH_MS = 40 * 60 * 1000;
const MODERATION_BADGE_COLLAPSE_ID = "moderation-badge";
const REQUEST_TIMEOUT_MS = 20_000;

export type ApnsConfigStatus =
  | { status: "configured"; environment: ApnsConfig["environment"]; config: ApnsConfig }
  | {
      status: "disabled" | "misconfigured";
      environment: ApnsConfig["environment"] | null;
      missing: string[];
      invalid: string[];
    };

/// Reports configuration state without exposing secret values. A completely
/// absent configuration is disabled; partial or malformed configuration is a
/// production-visible error.
export const inspectApnsConfig = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApnsConfigStatus> => {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const authKey = normalizePemKey(env.APNS_AUTH_KEY);
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  const rawEnvironment = env.APNS_ENVIRONMENT?.trim();
  const environment =
    rawEnvironment === undefined || rawEnvironment === ""
      ? "development"
      : rawEnvironment === "production" || rawEnvironment === "development"
        ? rawEnvironment
        : null;
  const missing = [
    ["APNS_TEAM_ID", teamId],
    ["APNS_KEY_ID", keyId],
    ["APNS_AUTH_KEY", env.APNS_AUTH_KEY?.trim()],
    ["APNS_BUNDLE_ID", bundleId],
  ]
    .filter(([, configured]) => !configured)
    .map(([name]) => name!);
  const invalid = [
    ...(env.APNS_AUTH_KEY?.trim() && !authKey ? ["APNS_AUTH_KEY"] : []),
    ...(environment === null ? ["APNS_ENVIRONMENT"] : []),
  ];
  if (missing.length === 4 && invalid.length === 0 && !rawEnvironment) {
    return { status: "disabled", environment: null, missing, invalid };
  }
  if (missing.length > 0 || invalid.length > 0 || environment === null) {
    return { status: "misconfigured", environment, missing, invalid };
  }
  try {
    await importPKCS8(authKey!, "ES256");
  } catch {
    return {
      status: "misconfigured",
      environment,
      missing,
      invalid: ["APNS_AUTH_KEY"],
    };
  }
  return {
    status: "configured",
    environment,
    config: { teamId: teamId!, keyId: keyId!, authKey: authKey!, bundleId: bundleId!, environment },
  };
};

/// Reads the APNs config from the environment. Returns null unless the complete
/// configuration is valid so callers can safely fall back to a no-op sender.
export const loadApnsConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ApnsConfig | null => {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const authKey = normalizePemKey(env.APNS_AUTH_KEY);
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  const rawEnvironment = env.APNS_ENVIRONMENT?.trim();
  const environment =
    rawEnvironment === undefined || rawEnvironment === ""
      ? "development"
      : rawEnvironment === "production" || rawEnvironment === "development"
        ? rawEnvironment
        : null;
  if (!teamId || !keyId || !authKey || !bundleId || environment === null) return null;
  return { teamId, keyId, authKey, bundleId, environment };
};

/// `.p8` keys are multi-line PEM. When carried through a `.env` file the
/// newlines are frequently escaped as the literal two-character sequence
/// `\n`; normalize those back to real newlines so `importPKCS8` accepts it.
export const normalizePemKey = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const unescaped = trimmed.replace(/\\n/g, "\n");
  return unescaped.includes("BEGIN PRIVATE KEY") ? unescaped : undefined;
};

/// Builds the JSON payload Apple expects. `data` is merged at the top level
/// (matching the existing mobile contract) but `aps` always wins so custom
/// keys can never clobber the reserved envelope.
export const buildApnsPayload = (notification: ApnsNotification): Record<string, unknown> => {
  const aps: Record<string, unknown> =
    notification.kind === "alert"
      ? {
          alert: { title: notification.title, body: notification.body },
          sound: "default",
        }
      : { badge: notification.badge };
  if (notification.kind === "alert") {
    if (notification.threadId) aps["thread-id"] = notification.threadId;
    if (notification.category) aps.category = notification.category;
    if (notification.mutableContent) aps["mutable-content"] = 1;
    if (notification.badge !== undefined) aps.badge = notification.badge;
  }
  return { ...notification.data, aps };
};

/// macOS / iOS / iPadOS / visionOS / tvOS share one bundle id, but the watch
/// app registers under `<bundleId>.watch`. Derive the per-device topic from
/// the stored platform string.
export const topicForPlatform = (bundleId: string, platform: string): string =>
  platform === "watchos" ? `${bundleId}.watch` : bundleId;

/// APNs `reason` strings that mean the token is permanently invalid and the
/// device row should be revoked so we stop pushing to it.
const PERMANENT_TOKEN_FAILURES = new Set([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
]);

export class Http2ApnsSender {
  private readonly config: ApnsConfig;
  private readonly host: string;
  private session: http2.ClientHttp2Session | null = null;
  private signingKey: ApnsSigningKey | null = null;
  private cachedJwt: { token: string; createdAt: number } | null = null;

  constructor(config: ApnsConfig) {
    this.config = config;
    this.host = config.environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST;
  }

  async send(
    userId: string,
    notification: ApnsNotification,
    beforeSubmit?: ApnsDeliveryFence,
  ): Promise<void> {
    const preferenceKey = notification.kind === "alert" ? notification.preferenceKey : null;
    const devices = await findTargetDevices(userId, preferenceKey);
    if (devices.length === 0) return;
    const jwt = await this.providerToken();
    const payload = JSON.stringify(buildApnsPayload(notification));
    const collapseId =
      notification.kind === "badge" ? MODERATION_BADGE_COLLAPSE_ID : notification.collapseId;
    const leaseExpiresAt = beforeSubmit ? await beforeSubmit() : null;
    if (
      beforeSubmit &&
      (!leaseExpiresAt || leaseExpiresAt.getTime() - Date.now() < APNS_DELIVERY_FENCE_MINIMUM_MS)
    ) {
      throw new Error("APNs delivery fence rejected a stale badge claim");
    }
    const results = await Promise.allSettled(
      devices.map((device) =>
        this.deliver(device, jwt, payload, collapseId, leaseExpiresAt, beforeSubmit),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason
              : new Error("APNs device delivery failed", { cause: result.reason }),
          ]
        : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `APNs delivery failed for ${failures.length} of ${devices.length} devices`,
      );
    }
    log.debug(
      {
        component: "apns",
        userId,
        notificationKind: notification.kind,
        ...(preferenceKey === null ? {} : { preferenceKey }),
        deviceCount: devices.length,
      },
      "APNs fan-out completed",
    );
  }

  private async deliver(
    device: { id: string; apnsToken: string; platform: string },
    jwt: string,
    payload: string,
    collapseId: string | undefined,
    leaseExpiresAt: Date | null,
    beforeSubmit: ApnsDeliveryFence | undefined,
  ): Promise<void> {
    const refreshedLeaseExpiresAt = beforeSubmit ? await beforeSubmit() : leaseExpiresAt;
    if (
      beforeSubmit &&
      (!refreshedLeaseExpiresAt ||
        refreshedLeaseExpiresAt.getTime() - Date.now() < APNS_DELIVERY_FENCE_MINIMUM_MS)
    ) {
      throw new Error("APNs delivery fence expired before submission");
    }

    let result: { status: number; reason?: string; apnsId?: string };
    try {
      result = await this.post(
        device.apnsToken,
        this.topic(device.platform),
        jwt,
        payload,
        collapseId,
      );
    } catch (error) {
      const errorRecord =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
      log.warn(
        {
          component: "apns",
          errorName: error instanceof Error ? error.name : "unknown",
          errorCode: typeof errorRecord.code === "string" ? errorRecord.code : undefined,
          deviceId: device.id,
          platform: device.platform,
        },
        "APNs transport error",
      );
      // A transport error often means the session is dead; drop it so the
      // next send reconnects.
      this.resetSession();
      throw error instanceof Error ? error : new Error("APNs transport failed", { cause: error });
    }

    if (result.status === 200) return;
    if (result.status === 410 || PERMANENT_TOKEN_FAILURES.has(result.reason ?? "")) {
      await this.revokeDevice(device.id);
      log.warn(
        {
          component: "apns",
          status: result.status,
          reason: result.reason ?? "unknown",
          apnsId: result.apnsId,
          deviceId: device.id,
          platform: device.platform,
        },
        "APNs rejected device token; device revoked",
      );
      return;
    }

    log.warn(
      {
        component: "apns",
        status: result.status,
        reason: result.reason ?? "unknown",
        apnsId: result.apnsId,
        deviceId: device.id,
        platform: device.platform,
      },
      "APNs delivery failed",
    );
    throw new Error(`APNs delivery failed with status ${result.status}`);
  }

  private topic(platform: string): string {
    return topicForPlatform(this.config.bundleId, platform);
  }

  private async revokeDevice(deviceId: string): Promise<void> {
    try {
      await db.mobileDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
    } catch {
      // Best-effort cleanup; never throw out of the push path.
    }
  }

  protected post(
    token: string,
    topic: string,
    jwt: string,
    payload: string,
    collapseId: string | undefined,
  ): Promise<{ status: number; reason?: string; apnsId?: string }> {
    return new Promise((resolve, reject) => {
      const session = this.ensureSession();
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
        ...(collapseId === undefined ? {} : { "apns-collapse-id": collapseId }),
      });
      let status = 0;
      let body = "";
      let apnsId: string | undefined;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`APNs request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        req.close(http2.constants.NGHTTP2_CANCEL);
      }, REQUEST_TIMEOUT_MS);
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      timeout.unref();
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
        const header = headers["apns-id"];
        apnsId = Array.isArray(header) ? header[0] : header;
      });
      req.on("data", (chunk: string | Buffer) => {
        body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      req.on("error", (error) =>
        settle(() =>
          reject(
            error instanceof Error ? error : new Error("APNs request failed", { cause: error }),
          ),
        ),
      );
      req.on("end", () => {
        let reason: string | undefined;
        if (body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            // Non-JSON error body; leave reason undefined.
          }
        }
        settle(() =>
          resolve({
            status,
            ...(reason === undefined ? {} : { reason }),
            ...(apnsId === undefined ? {} : { apnsId }),
          }),
        );
      });
      req.end(payload);
    });
  }

  private ensureSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    const session = http2.connect(this.host);
    session.on("error", () => this.resetSession());
    session.on("goaway", () => this.resetSession());
    session.on("close", () => this.resetSession());
    this.session = session;
    return session;
  }

  private resetSession(): void {
    if (this.session && !this.session.destroyed) {
      this.session.destroy();
    }
    this.session = null;
  }

  private async providerToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedJwt && now - this.cachedJwt.createdAt < JWT_REFRESH_MS) {
      return this.cachedJwt.token;
    }
    this.signingKey ??= await importPKCS8(this.config.authKey, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(this.signingKey);
    this.cachedJwt = { token, createdAt: now };
    return token;
  }
}
