import { beforeEach, describe, expect, it } from "vitest";
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

  it("rejects corrupted ciphertext", () => {
    const encrypted = encryptSessionSecret("refresh-token");
    if (!encrypted) throw new Error("expected ciphertext");
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSessionSecret(parts.join("."))).toThrow();
  });
});
