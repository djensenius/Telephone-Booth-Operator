import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
      if (c.req.header("authorization") === "Bearer test-token") {
        await next();
        return;
      }
      return c.json({ error: "invalid_token" }, 401);
    },
}));

import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedFile } from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  return createApp();
};

describe("questions routes", () => {
  beforeEach(setup);

  it("requires operator auth for question mutations", async () => {
    const app = createApp();
    const res = await app.request("/v1/questions", {
      method: "POST",
      body: JSON.stringify({ prompt: "Hello?", audioFileId: crypto.randomUUID() }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("creates as draft, activates, randomly selects, deactivates, and archives", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const audio = seedFile({ sha256: "1".repeat(64), durationMs: 2500 });

    const create = await app.request("/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: "What did you hear?", audioFileId: audio.id }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const question = await create.json();
    expect(question).toMatchObject({ prompt: "What did you hear?", status: "draft" });
    expect(question.audio).toMatchObject({ sha256: "1".repeat(64), durationMs: 2500 });

    // Drafts are listed for management but not served to the phone.
    const list = await app.request("/v1/questions?limit=10", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: question.id, status: "draft" }],
      nextCursor: null,
    });

    const draftRandom = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(draftRandom.status).toBe(404);

    // Activating makes it eligible for the phone.
    const activate = await app.request(`/v1/questions/${question.id}/activate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(activate.status, await activate.clone().text()).toBe(200);
    await expect(activate.json()).resolves.toMatchObject({ id: question.id, status: "active" });

    const missingBearer = await app.request("/v1/questions/random");
    expect(missingBearer.status).toBe(401);

    const random = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(random.status).toBe(200);
    await expect(random.json()).resolves.toMatchObject({
      id: question.id,
      status: "active",
      audio: { sha256: "1".repeat(64), durationMs: 2500 },
    });

    // Deactivating moves it back to draft and off the phone again.
    const deactivate = await app.request(`/v1/questions/${question.id}/deactivate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(deactivate.status).toBe(200);
    await expect(deactivate.json()).resolves.toMatchObject({ id: question.id, status: "draft" });
    const afterDeactivate = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(afterDeactivate.status).toBe(404);

    // Archiving hides it from the default management list entirely.
    const deleted = await app.request(`/v1/questions/${question.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);

    const afterArchive = await app.request("/v1/questions?limit=10", { headers: { cookie } });
    await expect(afterArchive.json()).resolves.toMatchObject({ items: [], nextCursor: null });

    const archivedFilter = await app.request("/v1/questions?status=archived", {
      headers: { cookie },
    });
    await expect(archivedFilter.json()).resolves.toMatchObject({
      items: [{ id: question.id, status: "archived" }],
    });

    const none = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(none.status).toBe(404);
  });

  it("returns 404 when activating a missing question", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request(`/v1/questions/${crypto.randomUUID()}/activate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
