import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  decryptSessionSecret,
  encryptSessionSecret,
  resetSessionCryptoForTests,
} from "../src/lib/session.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("session crypto", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.SESSION_ENCRYPTION_KEY = key;
    resetSessionCryptoForTests();
  });

  it("round-trips encrypted values", () => {
    const encrypted = encryptSessionSecret("refresh-token");
    expect(encrypted).not.toBe("refresh-token");
    expect(decryptSessionSecret(encrypted)).toBe("refresh-token");
  });

  it("encrypts access tokens", () => {
    const encrypted = encryptSessionSecret("access-token-value");
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("access-token-value");
    expect(decryptSessionSecret(encrypted)).toBe("access-token-value");
  });

  it("encrypts id tokens", () => {
    const encrypted = encryptSessionSecret("eyJhbGciOiJSUzI1NiJ9.fake-id-token");
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(decryptSessionSecret(encrypted)).toBe("eyJhbGciOiJSUzI1NiJ9.fake-id-token");
  });

  it("returns legacy plaintext values unchanged for graceful migration", () => {
    // Pre-encryption rows stored plain JWT strings; these should be returned as-is
    const legacy = "eyJhbGciOiJSUzI1NiJ9.legacy-plaintext";
    expect(decryptSessionSecret(legacy)).toBe(legacy);
  });

  it("returns null for null/undefined input", () => {
    expect(encryptSessionSecret(null)).toBeNull();
    expect(encryptSessionSecret(undefined)).toBeNull();
    expect(decryptSessionSecret(null)).toBeNull();
    expect(decryptSessionSecret(undefined)).toBeNull();
  });

  it("rejects corrupted ciphertext", () => {
    const encrypted = encryptSessionSecret("refresh-token");
    if (!encrypted) throw new Error("expected ciphertext");
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSessionSecret(parts.join("."))).toThrow();
  });
});
