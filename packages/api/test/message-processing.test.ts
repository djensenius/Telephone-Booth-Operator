import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { createHash } from "node:crypto";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedMessage, store } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = (): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
};

const headers = (): Record<string, string> => ({
  cookie: operatorCookie(),
  "content-type": "application/json",
});

const claim = async (app: ReturnType<typeof createApp>) => {
  const response = await app.request("/v1/message-processing/claim", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({}),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    claim: null | {
      message: { id: string };
      leaseToken: string;
      needs: string[];
      defaultTranscriptionLanguage: string | null;
    };
  }>;
};

describe("operator message processing leases", () => {
  beforeEach(setup);

  it("requires an OIDC operator session", async () => {
    const response = await createApp().request("/v1/message-processing/summary");
    expect(response.status).toBe(401);
  });

  it("atomically leases one hydrated current-installation message", async () => {
    const first = seedMessage({ status: "pending" });
    const second = seedMessage({ status: "pending" });
    const active = [...store.installations.values()][0];
    if (active) active.defaultTranscriptionLanguage = "fr-CA";
    const app = createApp();

    const [a, b] = await Promise.all([claim(app), claim(app)]);
    const claimed = [a.claim, b.claim].filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((entry) => entry.message.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(claimed.every((entry) => entry.needs[0] === "transcription")).toBe(true);
    expect(claimed.every((entry) => entry.defaultTranscriptionLanguage === "fr-CA")).toBe(true);
    expect(claimed.every((entry) => entry.leaseToken.length >= 32)).toBe(true);

    const summary = await app.request("/v1/message-processing/summary", { headers: headers() });
    expect(await summary.json()).toMatchObject({
      queued: 0,
      leased: 2,
      terminal: 0,
      needs: { transcription: 2 },
    });
  });

  it("persists a no-speech likely-hangup review without fabricating a transcript", async () => {
    const message = seedMessage({ status: "pending" });
    const app = createApp();
    const leased = (await claim(app)).claim;
    expect(leased?.message.id).toBe(message.id);

    const response = await app.request(`/v1/message-processing/${message.id}/complete`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        leaseToken: leased?.leaseToken,
        transcription: { text: "", processDownstream: false },
        review: { classification: "likely_hangup", recommendation: "delete" },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      needs: [],
      message: {
        reviewClassification: "likely_hangup",
        reviewRecommendation: "delete",
        status: "pending",
      },
    });
    expect([...store.transcriptions.values()]).toHaveLength(1);
    expect([...store.transcriptions.values()][0]?.text).toBe("");
    expect(store.messages.get(message.id)?.status).toBe("pending");
  });

  it("rejects a stale lease token without recording a result", async () => {
    const message = seedMessage({ status: "pending" });
    const app = createApp();
    await claim(app);
    const response = await app.request(`/v1/message-processing/${message.id}/complete`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        leaseToken: "x".repeat(32),
        transcription: { text: "stale" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "lease_lost" });
    expect([...store.transcriptions.values()]).toHaveLength(0);
  });

  it("stores a leased transcription, translation, and advisory moderation result", async () => {
    const message = seedMessage({ status: "pending" });
    const app = createApp();
    const leased = (await claim(app)).claim;
    if (leased === null) throw new Error("expected a claim");

    const response = await app.request(`/v1/message-processing/${message.id}/complete`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        leaseToken: leased.leaseToken,
        transcription: { text: "bonjour", language: "fr-CA", model: "local-speech" },
        translation: {
          translatedText: "hello",
          translatedLanguage: "en",
          model: "local-translate",
        },
        moderation: {
          inputSha256: createHash("sha256").update("hello", "utf8").digest("hex"),
          flagged: false,
          recommendation: "approve",
          maxScore: 0.01,
          model: "local-moderation",
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ needs: [] });
    const transcription = [...store.transcriptions.values()][0];
    const moderation = [...store.moderations.values()][0];
    expect(transcription).toMatchObject({
      text: "bonjour",
      translationStatus: "succeeded",
      translatedText: "hello",
      translationProvider: "on_device",
    });
    expect(moderation).toMatchObject({
      provider: "on_device",
      status: "succeeded",
      recommendation: "approve",
    });
  });

  it("releases expired claims and stops retrying after terminal failures", async () => {
    const message = seedMessage({ status: "pending" });
    const app = createApp();
    const first = (await claim(app)).claim;
    if (first === null) throw new Error("expected a claim");
    await app.request(`/v1/message-processing/${message.id}/fail`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ leaseToken: first.leaseToken, errorCode: "offline" }),
    });
    const second = (await claim(app)).claim;
    if (second === null) throw new Error("expected a second claim");
    await app.request(`/v1/message-processing/${message.id}/fail`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ leaseToken: second.leaseToken, errorCode: "offline" }),
    });
    const third = (await claim(app)).claim;
    if (third === null) throw new Error("expected a third claim");
    const terminal = await app.request(`/v1/message-processing/${message.id}/fail`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ leaseToken: third.leaseToken, errorCode: "offline" }),
    });
    expect(await terminal.json()).toEqual({ ok: true, terminal: true });
    expect((await claim(app)).claim).toBeNull();

    const summary = await app.request("/v1/message-processing/summary", { headers: headers() });
    expect(await summary.json()).toMatchObject({ terminal: 1, queued: 0, leased: 0 });
  });

  it("refuses completion once the installation has ended", async () => {
    const message = seedMessage({ status: "pending" });
    const app = createApp();
    const leased = (await claim(app)).claim;
    const installation = [...store.installations.values()][0];
    if (installation) installation.endedAt = new Date();

    const response = await app.request(`/v1/message-processing/${message.id}/complete`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ leaseToken: leased?.leaseToken, transcription: { text: "late" } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "installation_ended" });
  });
});
