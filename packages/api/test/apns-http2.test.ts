import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { generateKeyPairSync } from "node:crypto";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import {
  buildApnsPayload,
  Http2ApnsSender,
  inspectApnsConfig,
  loadApnsConfigFromEnv,
  normalizePemKey,
  topicForPlatform,
} from "../src/lib/apns-http2.js";
import { resetFakeDb, seedMobileDevice } from "./support/fake-db.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validAuthKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

beforeEach(() => {
  resetFakeDb();
});

describe("buildApnsPayload", () => {
  it("builds a standard alert envelope with thread and category", () => {
    const payload = buildApnsPayload({
      kind: "alert",
      preferenceKey: "messageReceived",
      title: "New booth message",
      body: "A new recording is ready to moderate.",
      threadId: "message:abc",
      category: "BOOTH_MESSAGE",
      data: { messageId: "abc" },
    });

    expect(payload).toMatchObject({
      messageId: "abc",
      aps: {
        alert: { title: "New booth message", body: "A new recording is ready to moderate." },
        sound: "default",
        "thread-id": "message:abc",
        category: "BOOTH_MESSAGE",
      },
    });
  });

  it("keeps alert envelopes badge-free", () => {
    const payload = buildApnsPayload({
      kind: "alert",
      preferenceKey: "callStarted",
      title: "t",
      body: "b",
    });
    expect((payload.aps as Record<string, unknown>).badge).toBeUndefined();
  });

  it("never lets custom data overwrite the reserved aps envelope", () => {
    const payload = buildApnsPayload({
      kind: "alert",
      preferenceKey: "messageReceived",
      title: "t",
      body: "b",
      data: { aps: { badge: 999 }, extra: "x" },
    });
    expect((payload.aps as Record<string, unknown>).badge).toBeUndefined();
    expect(payload.extra).toBe("x");
  });

  it("builds a badge-only envelope without an alert or sound", () => {
    const payload = buildApnsPayload({
      kind: "badge",
      badge: 4,
      data: { awaitingModeration: 4 },
    });

    expect(payload).toEqual({
      awaitingModeration: 4,
      aps: { badge: 4 },
    });
  });
});

describe("topicForPlatform", () => {
  it("uses the bare bundle id for phone-family platforms", () => {
    for (const platform of ["ios", "ipados", "macos", "visionos", "tvos"]) {
      expect(topicForPlatform("com.example.app", platform)).toBe("com.example.app");
    }
  });

  it("appends .watch for the watch app", () => {
    expect(topicForPlatform("com.example.app", "watchos")).toBe("com.example.app.watch");
  });
});

describe("normalizePemKey", () => {
  it("unescapes literal \\n sequences into real newlines", () => {
    const raw = "-----BEGIN PRIVATE KEY-----\\nMIIBVAIB\\n-----END PRIVATE KEY-----";
    const normalized = normalizePemKey(raw);
    expect(normalized).toBe("-----BEGIN PRIVATE KEY-----\nMIIBVAIB\n-----END PRIVATE KEY-----");
  });

  it("returns undefined for empty or non-PEM input", () => {
    expect(normalizePemKey(undefined)).toBeUndefined();
    expect(normalizePemKey("   ")).toBeUndefined();
    expect(normalizePemKey("not a key")).toBeUndefined();
  });
});

describe("loadApnsConfigFromEnv", () => {
  const escapedAuthKey = validAuthKey.replace(/\n/g, "\\n");
  const base = {
    APNS_TEAM_ID: "TEAM123",
    APNS_KEY_ID: "KEY123",
    APNS_AUTH_KEY: escapedAuthKey,
    APNS_BUNDLE_ID: "com.example.app",
  } as NodeJS.ProcessEnv;

  it("returns null when any required variable is missing", () => {
    expect(loadApnsConfigFromEnv({})).toBeNull();
    expect(loadApnsConfigFromEnv({ ...base, APNS_BUNDLE_ID: undefined })).toBeNull();
  });

  it("defaults to the development (sandbox) environment", () => {
    expect(loadApnsConfigFromEnv(base)?.environment).toBe("development");
  });

  it("selects production only when explicitly requested", () => {
    const config = loadApnsConfigFromEnv({ ...base, APNS_ENVIRONMENT: "production" });
    expect(config?.environment).toBe("production");
    expect(config?.bundleId).toBe("com.example.app");
    expect(config?.authKey).toContain("\n");
  });

  it("distinguishes disabled and malformed configuration without exposing values", async () => {
    await expect(inspectApnsConfig({})).resolves.toMatchObject({
      status: "disabled",
      environment: null,
      missing: ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_AUTH_KEY", "APNS_BUNDLE_ID"],
    });
    await expect(
      inspectApnsConfig({ ...base, APNS_ENVIRONMENT: "staging" }),
    ).resolves.toMatchObject({
      status: "misconfigured",
      environment: null,
      invalid: ["APNS_ENVIRONMENT"],
    });
    await expect(
      inspectApnsConfig({
        ...base,
        APNS_AUTH_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      }),
    ).resolves.toMatchObject({
      status: "misconfigured",
      invalid: ["APNS_AUTH_KEY"],
    });
  });

  it("reports configured only after importing a valid ES256 PKCS#8 key", async () => {
    await expect(inspectApnsConfig(base)).resolves.toMatchObject({
      status: "configured",
      environment: "development",
    });
  });
});

describe("Http2ApnsSender", () => {
  it("waits for device attempts and propagates transient APNs failures", async () => {
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    class TransientFailureSender extends Http2ApnsSender {
      protected override post(): Promise<{ status: number; reason: string }> {
        return Promise.resolve({ status: 503, reason: "ServiceUnavailable" });
      }
    }
    const sender = new TransientFailureSender({
      teamId: "TEAM123",
      keyId: "KEY123",
      authKey: validAuthKey,
      bundleId: "com.example.app",
      environment: "development",
    });

    await expect(
      sender.send("operator-1", {
        kind: "badge",
        badge: 2,
      }),
    ).rejects.toThrow("APNs delivery failed for 1 of 1 devices");
  });
});
