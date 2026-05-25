import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

describe("uploads routes", () => {
  beforeEach(setup);

  it("issues a 15-minute SAS URL for valid uploads", async () => {
    const app = createApp();
    const before = Date.now();
    const sha256 = "c".repeat(64);
    const res = await app.request("/v1/uploads/sas", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({
        kind: "question-audio",
        sha256,
        sizeBytes: 100,
        contentType: "audio/flac",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ blobName: `questions/cc/${sha256}.flac` });
    expect(body.uploadUrl).toContain("sp=cw");
    const ttlMs = new Date(body.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(14 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000 + 5000);
  });

  it("rejects malformed sha256 values", async () => {
    const app = createApp();
    const res = await app.request("/v1/uploads/sas", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({
        kind: "message",
        sha256: "not-a-sha",
        sizeBytes: 100,
        contentType: "audio/flac",
      }),
    });
    expect(res.status).toBe(400);
  });
});
