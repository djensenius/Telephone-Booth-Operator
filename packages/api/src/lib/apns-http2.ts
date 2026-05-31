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
import { findTargetDevices, type ApnsNotification } from "./apns.js";

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

/// Reads the APNs config from the environment. Returns null when any
/// required variable is missing so callers can fall back to a no-op sender.
export const loadApnsConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): ApnsConfig | null => {
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const authKey = normalizePemKey(env.APNS_AUTH_KEY);
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  if (!teamId || !keyId || !authKey || !bundleId) return null;
  const environment = env.APNS_ENVIRONMENT?.trim() === "production" ? "production" : "development";
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
  const aps: Record<string, unknown> = {
    alert: { title: notification.title, body: notification.body },
    sound: "default",
  };
  if (typeof notification.badge === "number") aps.badge = notification.badge;
  if (notification.threadId) aps["thread-id"] = notification.threadId;
  if (notification.category) aps.category = notification.category;
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

  async send(userId: string, notification: ApnsNotification): Promise<void> {
    const devices = await findTargetDevices(userId, notification.preferenceKey);
    if (devices.length === 0) return;
    const jwt = await this.providerToken();
    const payload = JSON.stringify(buildApnsPayload(notification));
    await Promise.allSettled(
      devices.map((device) => this.deliver(device, jwt, payload)),
    );
  }

  private async deliver(
    device: { id: string; apnsToken: string; platform: string },
    jwt: string,
    payload: string,
  ): Promise<void> {
    try {
      const result = await this.post(device.apnsToken, this.topic(device.platform), jwt, payload);
      if (result.status === 200) return;
      if (result.status === 410 || PERMANENT_TOKEN_FAILURES.has(result.reason ?? "")) {
        await this.revokeDevice(device.id);
      } else {
        console.warn(
          `[apns] push failed status=${result.status} reason=${result.reason ?? "?"} device=${device.id}`,
        );
      }
    } catch (error) {
      console.warn(`[apns] push error device=${device.id}: ${(error as Error).message}`);
      // A transport error often means the session is dead; drop it so the
      // next send reconnects.
      this.resetSession();
    }
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

  private post(
    token: string,
    topic: string,
    jwt: string,
    payload: string,
  ): Promise<{ status: number; reason?: string }> {
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
      });
      let status = 0;
      let body = "";
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("error", reject);
      req.on("end", () => {
        let reason: string | undefined;
        if (body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason;
          } catch {
            // Non-JSON error body; leave reason undefined.
          }
        }
        resolve(reason === undefined ? { status } : { status, reason });
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
