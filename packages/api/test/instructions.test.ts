import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken:
    () =>
    async (
      c: {
        req: { header: (name: string) => string | undefined };
        json: (body: unknown, status?: number) => Response;
      },
      next: () => Promise<void>,
    ) => {
      if (c.req.header("authorization") === "******") {
        await next();
        return;
      }
      return c.json({ error: "invalid_token" }, 401);
    },
}));

import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedFile, seedInstruction } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

describe("instructions routes", () => {
  beforeEach(setup);
  afterEach(() => vi.restoreAllMocks());

  it("creates, randomly serves active instructions, deactivates, and deletes", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const olderAudio = seedFile({ sha256: "1".repeat(64), durationMs: 1500 });
    seedInstruction({
      audioId: olderAudio.id,
      description: "Older",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const audio = seedFile({ sha256: "2".repeat(64), durationMs: 2500 });

    const create = await app.request("/v1/instructions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ description: "Main instructions", audioFileId: audio.id }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const instruction = await create.json();
    expect(instruction).toMatchObject({ description: "Main instructions", status: "active" });
    expect(instruction.audio).toMatchObject({ sha256: "2".repeat(64), durationMs: 2500 });

    const list = await app.request("/v1/instructions?limit=10", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.nextCursor).toBeNull();
    expect(listed.items[0]).toMatchObject({ id: instruction.id, status: "active" });

    const missingBearer = await app.request("/v1/instructions/random");
    expect(missingBearer.status).toBe(401);

    const randomSpy = vi.spyOn(Math, "random").mockReturnValueOnce(0);
    const random = await app.request("/v1/instructions/random", {
      headers: { authorization: "******" },
    });
    expect(random.status, await random.clone().text()).toBe(200);
    await expect(random.json()).resolves.toMatchObject({
      id: instruction.id,
      status: "active",
      audio: { sha256: "2".repeat(64), durationMs: 2500 },
    });

    randomSpy.mockReturnValueOnce(0.99);
    const compatibilityAlias = await app.request("/v1/instructions/current", {
      headers: { authorization: "******" },
    });
    expect(compatibilityAlias.status, await compatibilityAlias.clone().text()).toBe(200);
    await expect(compatibilityAlias.json()).resolves.toMatchObject({ description: "Older" });

    const deactivate = await app.request(`/v1/instructions/${instruction.id}/deactivate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(deactivate.status).toBe(200);
    await expect(deactivate.json()).resolves.toMatchObject({
      id: instruction.id,
      status: "inactive",
    });

    const afterDeactivate = await app.request("/v1/instructions/random", {
      headers: { authorization: "******" },
    });
    expect(afterDeactivate.status).toBe(200);
    await expect(afterDeactivate.json()).resolves.toMatchObject({ description: "Older" });

    const deleted = await app.request(`/v1/instructions/${instruction.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);
  });

  it("returns 404 when no active instruction exists", async () => {
    const app = createApp();
    const res = await app.request("/v1/instructions/random", {
      headers: { authorization: "******" },
    });
    expect(res.status, await res.clone().text()).toBe(404);
  });

  it("never selects inactive instructions", async () => {
    const app = createApp();
    const activeAudio = seedFile({ sha256: "3".repeat(64) });
    const inactiveAudio = seedFile({ sha256: "4".repeat(64) });
    const active = seedInstruction({
      audioId: activeAudio.id,
      description: "Available",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    seedInstruction({
      audioId: inactiveAudio.id,
      description: "Unavailable",
      status: "inactive",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const res = await app.request("/v1/instructions/random", {
      headers: { authorization: "******" },
    });

    expect(res.status, await res.clone().text()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: active.id, description: "Available" });
  });

  it("updates and clears an instruction description", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const audio = seedFile({ sha256: "5".repeat(64) });
    const instruction = seedInstruction({ audioId: audio.id, description: "Original" });

    const unauthorized = await app.request(`/v1/instructions/${instruction.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Nope" }),
    });
    expect(unauthorized.status).toBe(401);

    const update = await app.request(`/v1/instructions/${instruction.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "Updated" }),
    });
    expect(update.status, await update.clone().text()).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      id: instruction.id,
      description: "Updated",
    });

    const clear = await app.request(`/v1/instructions/${instruction.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: null }),
    });
    expect(clear.status, await clear.clone().text()).toBe(200);
    await expect(clear.json()).resolves.toMatchObject({ description: null });

    const missing = await app.request("/v1/instructions/11111111-1111-1111-1111-111111111111", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ description: "Missing" }),
    });
    expect(missing.status).toBe(404);
  });
});
