import { describe, expect, it } from "vite-plus/test";
import { generateKeyPairSync } from "node:crypto";

import {
  buildApnsPayload,
  inspectApnsConfig,
  loadApnsConfigFromEnv,
  normalizePemKey,
  topicForPlatform,
} from "../src/lib/apns-http2.js";

describe("buildApnsPayload", () => {
  it("builds a standard alert envelope with badge, thread, and category", () => {
    const payload = buildApnsPayload({
      preferenceKey: "messageReceived",
      title: "New booth message",
      body: "A new recording is ready to moderate.",
      badge: 3,
      threadId: "message:abc",
      category: "BOOTH_MESSAGE",
      data: { messageId: "abc" },
    });

    expect(payload).toMatchObject({
      messageId: "abc",
      aps: {
        alert: { title: "New booth message", body: "A new recording is ready to moderate." },
        sound: "default",
        badge: 3,
        "thread-id": "message:abc",
        category: "BOOTH_MESSAGE",
      },
    });
  });

  it("omits badge when not provided", () => {
    const payload = buildApnsPayload({
      preferenceKey: "callStarted",
      title: "t",
      body: "b",
    });
    expect((payload.aps as Record<string, unknown>).badge).toBeUndefined();
  });

  it("never lets custom data overwrite the reserved aps envelope", () => {
    const payload = buildApnsPayload({
      preferenceKey: "messageReceived",
      title: "t",
      body: "b",
      badge: 1,
      data: { aps: { badge: 999 }, extra: "x" },
    });
    expect((payload.aps as Record<string, unknown>).badge).toBe(1);
    expect(payload.extra).toBe("x");
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
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const validAuthKey = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString()
    .replace(/\n/g, "\\n");
  const base = {
    APNS_TEAM_ID: "TEAM123",
    APNS_KEY_ID: "KEY123",
    APNS_AUTH_KEY: validAuthKey,
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
