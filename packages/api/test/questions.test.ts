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
import {
  DEFAULT_INSTALLATION_ID,
  resetFakeDb,
  seedFile,
  seedInstallation,
  seedMessage,
  seedQuestion,
  store,
  timeOutNextQuestionDraw,
} from "./support/fake-db.js";
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

  it("requires admin auth for question updates", async () => {
    const app = createApp();
    const id = crypto.randomUUID();
    const body = JSON.stringify({ prompt: "Can you hear me?" });

    const unauthenticated = await app.request(`/v1/questions/${id}`, {
      method: "PATCH",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await app.request(`/v1/questions/${id}`, {
      method: "PATCH",
      body,
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie({ isAdmin: false }),
      },
    });
    expect(forbidden.status).toBe(403);
  });

  it("lists linked messages across installations with deletion-safe cursor pagination", async () => {
    const app = createApp();
    const question = seedQuestion({ status: "archived" });
    const otherQuestion = seedQuestion();
    const createdAt = new Date("2026-08-28T16:00:00.000Z");
    const newer = seedMessage({
      id: "22222222-2222-4222-8222-222222222222",
      questionId: question.id,
      installationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      createdAt,
    });
    const older = seedMessage({
      id: "11111111-1111-4111-8111-111111111111",
      questionId: question.id,
      installationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      createdAt,
    });
    seedMessage({ questionId: otherQuestion.id });
    seedMessage({ questionId: null });

    const unauthenticated = await app.request(`/v1/questions/${question.id}/messages`);
    expect(unauthenticated.status).toBe(401);

    const first = await app.request(`/v1/questions/${question.id}/messages?limit=1`, {
      headers: { cookie: operatorCookie() },
    });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ id: string; questionId: string }>;
      nextCursor: string | null;
    };
    expect(firstPage).toMatchObject({
      items: [{ id: newer.id, questionId: question.id }],
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toBe(newer.id);
    if (firstPage.nextCursor === null) throw new Error("expected a continuation cursor");

    store.messages.delete(newer.id);
    const second = await app.request(
      `/v1/questions/${question.id}/messages?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { cookie: operatorCookie() } },
    );
    expect(second.status, await second.clone().text()).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      items: [{ id: older.id, questionId: question.id }],
      nextCursor: null,
    });

    const invalidCursor = await app.request(
      `/v1/questions/${question.id}/messages?cursor=not-a-cursor`,
      { headers: { cookie: operatorCookie() } },
    );
    expect(invalidCursor.status).toBe(400);
    const nonCanonicalCursor = await app.request(
      `/v1/questions/${question.id}/messages?cursor=${encodeURIComponent(`${firstPage.nextCursor}!`)}`,
      { headers: { cookie: operatorCookie() } },
    );
    expect(nonCanonicalCursor.status).toBe(400);
    const emptyCursor = await app.request(`/v1/questions/${question.id}/messages?cursor=`, {
      headers: { cookie: operatorCookie() },
    });
    expect(emptyCursor.status).toBe(400);

    const missing = await app.request(`/v1/questions/${crypto.randomUUID()}/messages`, {
      headers: { cookie: operatorCookie() },
    });
    expect(missing.status).toBe(404);
  });

  it("keeps question pagination stable when the cursor row is deleted", async () => {
    const createdAt = new Date("2026-08-28T16:00:00.000Z");
    const newer = seedQuestion({
      id: "22222222-2222-4222-8222-222222222222",
      createdAt,
    });
    const older = seedQuestion({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt,
    });
    const app = createApp();
    const cookie = operatorCookie();

    const first = await app.request("/v1/questions?limit=1", { headers: { cookie } });
    const firstPage = (await first.json()) as { items: Array<{ id: string }>; nextCursor: string };
    expect(firstPage.items.map((item) => item.id)).toEqual([newer.id]);
    expect(firstPage.nextCursor).not.toBe(newer.id);

    store.questions.delete(newer.id);
    const second = await app.request(
      `/v1/questions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { cookie } },
    );
    await expect(second.json()).resolves.toMatchObject({
      items: [{ id: older.id }],
      nextCursor: null,
    });

    const invalid = await app.request("/v1/questions?cursor=not-a-cursor", {
      headers: { cookie },
    });
    expect(invalid.status).toBe(400);
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
    expect(question).toMatchObject({
      prompt: "What did you hear?",
      status: "draft",
      weight: 1,
      messageCount: 0,
    });
    expect(question.audio).toMatchObject({ sha256: "1".repeat(64), durationMs: 2500 });
    seedMessage({ questionId: question.id });
    seedMessage({ questionId: question.id });
    seedMessage({ questionId: null });

    const update = await app.request(`/v1/questions/${question.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: "What can you hear?", weight: 3 }),
    });
    expect(update.status, await update.clone().text()).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      id: question.id,
      prompt: "What can you hear?",
      weight: 3,
      messageCount: 2,
    });

    // Drafts are listed for management but not served to the phone.
    const list = await app.request("/v1/questions?limit=10", { headers: { cookie } });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ id: question.id, status: "draft", messageCount: 2 }],
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
    await expect(activate.json()).resolves.toMatchObject({
      id: question.id,
      status: "active",
      messageCount: 2,
    });

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
    await expect(deactivate.json()).resolves.toMatchObject({
      id: question.id,
      status: "draft",
      messageCount: 2,
    });
    const afterDeactivate = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(afterDeactivate.status).toBe(404);

    // Archiving hides it from the default management list entirely.
    const deleted = await app.request(`/v1/questions/${question.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);

    const archivedUpdate = await app.request(`/v1/questions/${question.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: "Too late to change" }),
    });
    expect(archivedUpdate.status).toBe(404);

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

  it("serves every weight-1 recording once before starting a new cycle", async () => {
    const active = [
      seedQuestion({ status: "active" }),
      seedQuestion({ status: "active" }),
      seedQuestion({ status: "active" }),
    ];
    seedQuestion({ status: "draft" });
    seedQuestion({ status: "archived" });
    const app = createApp();

    const served: string[] = [];
    for (let draw = 0; draw < active.length; draw += 1) {
      const response = await app.request("/v1/questions/random", { headers: phoneHeaders });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      served.push(((await response.json()) as { id: string }).id);
    }

    expect(new Set(served)).toEqual(new Set(active.map((question) => question.id)));
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.questionSelectionCycle).toBe(0);

    const nextCycle = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(nextCycle.status, await nextCycle.clone().text()).toBe(200);
    const nextId = ((await nextCycle.json()) as { id: string }).id;
    expect(nextId).not.toBe(served.at(-1));
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.questionSelectionCycle).toBe(1);
  });

  it("consumes each recording's weight as tickets and avoids consecutive repeats", async () => {
    const standard = seedQuestion({ status: "active", weight: 1 });
    const featured = seedQuestion({ status: "active", weight: 2 });
    const app = createApp();

    const served: string[] = [];
    for (let draw = 0; draw < 3; draw += 1) {
      const response = await app.request("/v1/questions/random", { headers: phoneHeaders });
      expect(response.status, await response.clone().text()).toBe(200);
      served.push(((await response.json()) as { id: string }).id);
    }

    expect(served.filter((id) => id === standard.id)).toHaveLength(1);
    expect(served.filter((id) => id === featured.id)).toHaveLength(2);
    expect(served[0]).not.toBe(served[1]);

    const nextCycle = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(nextCycle.status, await nextCycle.clone().text()).toBe(200);
    expect(((await nextCycle.json()) as { id: string }).id).not.toBe(served.at(-1));
  });

  it("adds a newly activated recording to the current ticket bag", async () => {
    const first = seedQuestion({ status: "active" });
    const second = seedQuestion({ status: "active" });
    const added = seedQuestion({ status: "draft" });
    const app = createApp();

    const initial = await app.request("/v1/questions/random", { headers: phoneHeaders });
    expect(initial.status, await initial.clone().text()).toBe(200);
    const initialId = ((await initial.json()) as { id: string }).id;

    const activate = await app.request(`/v1/questions/${added.id}/activate`, {
      method: "POST",
      headers: { cookie: operatorCookie() },
    });
    expect(activate.status, await activate.clone().text()).toBe(200);

    const remainder: string[] = [];
    for (let draw = 0; draw < 2; draw += 1) {
      const response = await app.request("/v1/questions/random", { headers: phoneHeaders });
      expect(response.status, await response.clone().text()).toBe(200);
      remainder.push(((await response.json()) as { id: string }).id);
    }
    expect(new Set([initialId, ...remainder])).toEqual(new Set([first.id, second.id, added.id]));
  });

  it("serializes concurrent draws so they consume different tickets", async () => {
    seedQuestion({ status: "active" });
    seedQuestion({ status: "active" });
    const app = createApp();

    const responses = await Promise.all([
      app.request("/v1/questions/random", { headers: phoneHeaders }),
      app.request("/v1/questions/random", { headers: phoneHeaders }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { id: string }).id),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("replays one ticket when the same logical draw is retried concurrently", async () => {
    seedQuestion({ status: "active" });
    seedQuestion({ status: "active" });
    const app = createApp();
    const headers = {
      ...phoneHeaders,
      "x-question-draw-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    const responses = await Promise.all([
      app.request("/v1/questions/random", { headers }),
      app.request("/v1/questions/random", { headers }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { id: string }).id),
    );
    expect(new Set(ids).size).toBe(1);
    const consumed = [...store.questions.values()].reduce(
      (total, question) => total + question.selectionsInCycle,
      0,
    );
    expect(consumed).toBe(1);
  });

  it("replays a draw after an intervening headerless request and normalizes UUID case", async () => {
    seedQuestion({ status: "active" });
    seedQuestion({ status: "active" });
    seedQuestion({ status: "active" });
    const app = createApp();
    const uppercaseDrawId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

    const first = await app.request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": uppercaseDrawId },
    });
    const intervening = await app.request("/v1/questions/random", { headers: phoneHeaders });
    const replay = await app.request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": uppercaseDrawId.toLowerCase() },
    });

    expect([first.status, intervening.status, replay.status]).toEqual([200, 200, 200]);
    const firstId = ((await first.json()) as { id: string }).id;
    const interveningId = ((await intervening.json()) as { id: string }).id;
    const replayId = ((await replay.json()) as { id: string }).id;
    expect(interveningId).not.toBe(firstId);
    expect(replayId).toBe(firstId);
    const consumed = [...store.questions.values()].reduce(
      (total, question) => total + question.selectionsInCycle,
      0,
    );
    expect(consumed).toBe(2);
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.recentQuestionDraws).toEqual([
      { drawId: uppercaseDrawId.toLowerCase(), questionId: firstId },
    ]);
  });

  it("retains only the newest 100 logical draws for retry replay", async () => {
    const question = seedQuestion({ status: "active" });
    const app = createApp();
    const drawIds = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );

    for (const drawId of drawIds) {
      const response = await app.request("/v1/questions/random", {
        headers: { ...phoneHeaders, "x-question-draw-id": drawId },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }

    const expectedRetainedDraws = drawIds.slice(1).map((drawId) => ({
      drawId,
      questionId: question.id,
    }));
    const installation = store.installations.get(DEFAULT_INSTALLATION_ID);
    expect(installation).toBeDefined();
    if (!installation) throw new Error("default installation was not seeded");
    expect(installation.recentQuestionDraws).toEqual(expectedRetainedDraws);
    const cycleBeforeReplay = installation.questionSelectionCycle;

    const retainedReplay = await app.request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": drawIds[1] },
    });
    expect(retainedReplay.status, await retainedReplay.clone().text()).toBe(200);
    await expect(retainedReplay.json()).resolves.toMatchObject({ id: question.id });
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)).toMatchObject({
      questionSelectionCycle: cycleBeforeReplay,
      recentQuestionDraws: expectedRetainedDraws,
    });

    const evictedReplay = await app.request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": drawIds[0] },
    });
    expect(evictedReplay.status, await evictedReplay.clone().text()).toBe(200);
    await expect(evictedReplay.json()).resolves.toMatchObject({ id: question.id });
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)).toMatchObject({
      questionSelectionCycle: cycleBeforeReplay + 1,
      recentQuestionDraws: [
        ...expectedRetainedDraws.slice(1),
        { drawId: drawIds[0], questionId: question.id },
      ],
    });
  });

  it("does not replay a draw-history question from another installation", async () => {
    const current = seedQuestion({ status: "active" });
    const previousInstallation = seedInstallation({
      endedAt: new Date("2025-12-31T23:59:59.000Z"),
    });
    const foreign = seedQuestion({
      status: "active",
      installationId: previousInstallation.id,
    });
    const drawId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const installation = store.installations.get(DEFAULT_INSTALLATION_ID);
    expect(installation).toBeDefined();
    if (!installation) return;
    installation.recentQuestionDraws = [{ drawId, questionId: foreign.id }];

    const response = await createApp().request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": drawId },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: current.id });
    expect(store.questions.get(current.id)?.selectionsInCycle).toBe(1);
    expect(store.questions.get(foreign.id)?.selectionsInCycle).toBe(0);
  });

  it("wraps an exhausted maximum cycle without overflowing PostgreSQL integers", async () => {
    const previous = seedQuestion({
      status: "active",
      lastSelectedCycle: 2_147_483_647,
      selectionsInCycle: 1,
    });
    const next = seedQuestion({
      status: "active",
      lastSelectedCycle: 2_147_483_647,
      selectionsInCycle: 1,
    });
    const installation = store.installations.get(DEFAULT_INSTALLATION_ID);
    expect(installation).toBeDefined();
    if (!installation) return;
    installation.questionSelectionCycle = 2_147_483_647;
    installation.lastSelectedQuestionId = previous.id;

    const response = await createApp().request("/v1/questions/random", {
      headers: phoneHeaders,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: next.id });
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.questionSelectionCycle).toBe(0);
    expect(store.questions.get(previous.id)).toMatchObject({
      lastSelectedCycle: null,
      selectionsInCycle: 0,
    });
    expect(store.questions.get(next.id)).toMatchObject({
      lastSelectedCycle: 0,
      selectionsInCycle: 1,
    });
  });

  it("rejects malformed draw ids without consuming a ticket", async () => {
    const question = seedQuestion({ status: "active" });
    const response = await createApp().request("/v1/questions/random", {
      headers: { ...phoneHeaders, "x-question-draw-id": "not-a-uuid" },
    });

    expect(response.status).toBe(400);
    expect(store.questions.get(question.id)?.selectionsInCycle).toBe(0);
  });

  it("returns a retryable response when rollover lock contention times out", async () => {
    seedQuestion({ status: "active" });
    timeOutNextQuestionDraw();

    const response = await createApp().request("/v1/questions/random", {
      headers: phoneHeaders,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({ error: "question_draw_busy" });
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
