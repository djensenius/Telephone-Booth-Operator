import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);
// The booth authenticates with a static bearer token; the straggler tests need
// to post as the phone without standing up the real Argon2id verification.
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
      if (c.req.header("authorization") === phoneHeaders.authorization) {
        await next();
        return;
      }
      return c.json({ error: "invalid_token" }, 401);
    },
}));

import { readTar } from "../src/lib/archive.js";
import { createApp } from "../src/index.js";
import {
  requireActiveInstallation,
  resetInstallationCacheForTests,
} from "../src/lib/installation.js";
import { resetStatsCacheForTests } from "../src/routes/stats.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure, seedBlobData } from "./support/fake-azure.js";
import {
  DEFAULT_INSTALLATION_ID,
  resetFakeDb,
  seedBoothEvent,
  seedCallSession,
  seedFile,
  seedMessage,
  seedMobileDevice,
  seedQuestion,
  store,
} from "./support/fake-db.js";
import { operatorCookie, phoneHeaders } from "./support/http.js";

const setup = (): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetInstallationCacheForTests();
  resetStatsCacheForTests();
};

const adminHeaders = (): { cookie: string } => ({ cookie: operatorCookie({ isAdmin: true }) });
const operatorHeaders = (): { cookie: string } => ({ cookie: operatorCookie({ isAdmin: false }) });

const jsonHeaders = (headers: { cookie: string }): Record<string, string> => ({
  ...headers,
  "content-type": "application/json",
});

// Ends the seeded installation so a new one can be started.
const endDefault = async (app: ReturnType<typeof createApp>): Promise<Response> =>
  app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}/end`, {
    method: "POST",
    headers: jsonHeaders(adminHeaders()),
    body: JSON.stringify({}),
  });

describe("installations", () => {
  beforeEach(setup);

  describe("auth", () => {
    it("requires a session to list", async () => {
      const res = await createApp().request("/v1/installations");
      expect(res.status).toBe(401);
    });

    it("requires admin to start a new installation", async () => {
      const res = await createApp().request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(operatorHeaders()),
        body: JSON.stringify({ name: "Nuit Blanche" }),
      });
      expect(res.status).toBe(403);
    });

    it("requires admin to end an installation", async () => {
      const res = await createApp().request(`/v1/installations/${DEFAULT_INSTALLATION_ID}/end`, {
        method: "POST",
        headers: jsonHeaders(operatorHeaders()),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it("requires admin to purge an installation", async () => {
      const res = await createApp().request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(operatorHeaders()),
        body: JSON.stringify({ confirmName: "Installation 1" }),
      });
      expect(res.status).toBe(403);
    });

    it("lets any operator read the history", async () => {
      const res = await createApp().request("/v1/installations", {
        headers: operatorHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string; isActive: boolean }[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.isActive).toBe(true);
    });
  });

  describe("current", () => {
    it("returns the active installation", async () => {
      const res = await createApp().request("/v1/installations/current", {
        headers: operatorHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; endedAt: string | null };
      expect(body.id).toBe(DEFAULT_INSTALLATION_ID);
      expect(body.endedAt).toBeNull();
    });

    it("404s once the era has been closed and none restarted", async () => {
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      const res = await app.request("/v1/installations/current", { headers: operatorHeaders() });
      expect(res.status).toBe(404);
    });
  });

  describe("ending an installation", () => {
    it("freezes summary counters, closes sessions, and empties the queue", async () => {
      seedCallSession({ id: "open-session", endedAt: null });
      seedCallSession({
        id: "closed-session",
        endedAt: new Date(),
        outcome: "recording_completed",
      });
      const pending = seedMessage({ status: "pending" });
      const approved = seedMessage({ status: "approved" });
      const question = seedQuestion({ status: "active" });
      seedBoothEvent({ type: "call_started", occurredAt: new Date("2026-02-01T00:00:00Z") });

      const app = createApp();
      const res = await endDefault(app);
      expect(res.status, await res.clone().text()).toBe(200);

      const body = (await res.json()) as {
        endedAt: string | null;
        isActive: boolean;
        summary: { calls: number; messages: number; questions: number; events: number } | null;
      };
      expect(body.isActive).toBe(false);
      expect(body.endedAt).not.toBeNull();
      expect(body.summary).toMatchObject({ calls: 2, messages: 2, questions: 1, events: 1 });

      // Open sessions are closed out with a distinguishable outcome.
      expect(store.callSessions.get("open-session")?.endedAt).not.toBeNull();
      expect(store.callSessions.get("open-session")?.outcome).toBe("installation_ended");
      // A session the booth already ended keeps its own outcome.
      expect(store.callSessions.get("closed-session")?.outcome).toBe("recording_completed");

      // The moderation queue starts empty; decided messages are untouched.
      expect(store.messages.get(pending.id)?.status).toBe("rejected");
      expect(store.messages.get(approved.id)?.status).toBe("approved");

      // This era's questions are retired.
      expect(store.questions.get(question.id)?.status).toBe("archived");
    });

    it("does not delete any data", async () => {
      const message = seedMessage({ status: "pending" });
      seedCallSession({ id: "s1" });
      seedBoothEvent({ type: "call_started" });

      expect((await endDefault(createApp())).status).toBe(200);

      expect(store.messages.get(message.id)).toBeDefined();
      expect(store.callSessions.get("s1")).toBeDefined();
      expect(store.boothEvents).toHaveLength(1);
    });

    it("rejects ending an already-ended installation", async () => {
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      const second = await endDefault(app);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: "installation_already_ended" });
    });

    // Two admins pressing "end" at once: only one may stamp `endedAt`. A second
    // stamp would drift from the `retiredAt` the first wrote onto the era's
    // questions, and that equality is what identifies a rollover straggler.
    it("lets only one of two concurrent ends win", async () => {
      const app = createApp();
      const question = seedQuestion({ status: "active", prompt: "Concurrent?" });

      const [first, second] = await Promise.all([endDefault(app), endDefault(app)]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const era = store.installations.get(DEFAULT_INSTALLATION_ID);
      expect(store.questions.get(question.id)?.retiredAt?.getTime()).toBe(era?.endedAt?.getTime());
    });

    it("404s for an unknown installation", async () => {
      const res = await createApp().request(
        "/v1/installations/11111111-1111-4111-8111-111111111111/end",
        { method: "POST", headers: jsonHeaders(adminHeaders()), body: JSON.stringify({}) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("starting a new installation", () => {
    it("refuses while one is still active and has recorded something", async () => {
      seedCallSession({ id: "live-call" });
      const res = await createApp().request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Second" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "installation_already_active" });
    });

    it("starts a blank slate once the previous era ended", async () => {
      seedQuestion({ status: "active", prompt: "Old prompt" });
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Nuit Blanche", location: "Toronto" }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as { id: string; name: string; isActive: boolean };
      expect(body).toMatchObject({ name: "Nuit Blanche", isActive: true });

      // copyQuestions defaults to false, so the new era has no questions.
      const carried = [...store.questions.values()].filter((q) => q.installationId === body.id);
      expect(carried).toHaveLength(0);
    });

    it("adopts an era the booth auto-created before the operator named one", async () => {
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      // A powered-on booth keeps posting events, and every booth write resolves
      // the active installation — lazily opening an unnamed one so a recording
      // is never dropped over admin bookkeeping.
      await requireActiveInstallation();
      const opened = [...store.installations.values()].find((row) => row.endedAt === null);
      expect(opened).toBeDefined();

      // Naming the era must not collide with the one the booth just opened.
      const res = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Nuit Blanche" }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.name).toBe("Nuit Blanche");
      expect(body.id).toBe(opened?.id);
      expect([...store.installations.values()].filter((r) => r.endedAt === null)).toHaveLength(1);
    });

    it("copies questions forward when asked, sharing the same audio file", async () => {
      const file = seedFile({ blobKey: "questions/ab/abc.flac", sha256: "sha-original" });
      seedQuestion({ status: "active", prompt: "Where do you feel most alone?", audioId: file.id });

      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Second run", copyQuestions: true }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const created = (await res.json()) as { id: string };

      const carried = [...store.questions.values()].filter((q) => q.installationId === created.id);
      expect(carried).toHaveLength(1);

      // The copy points at the *same* File row, so nothing is re-uploaded and
      // no unique constraint (blobKey, sha256) can be violated.
      expect(carried[0]?.audioId).toBe(file.id);
      expect(store.files.size).toBe(1);
    });
  });

  describe("rollover stragglers", () => {
    it("still accepts a recording for a question the rollover archived", async () => {
      const question = seedQuestion({ status: "active", prompt: "What did you lose?" });
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      // The booth read this question out before the operator ended the era and
      // only finishes uploading afterwards. Dropping it would lose a real
      // recording over admin bookkeeping.
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 3000, sha256: "c".repeat(64), questionId: question.id }),
      });
      expect(res.status, await res.clone().text()).toBe(201);

      // ...and it lands in the open era, where an operator will actually see it.
      const created = (await res.json()) as { id: string };
      const active = [...store.installations.values()].find((row) => row.endedAt === null);
      expect(store.messages.get(created.id)?.installationId).toBe(active?.id);
    });

    it("still refuses a question an operator retired by hand", async () => {
      const question = seedQuestion({ status: "archived", retiredAt: new Date() });
      const app = createApp();

      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...phoneHeaders },
        body: JSON.stringify({ durationMs: 3000, sha256: "d".repeat(64), questionId: question.id }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("copy-forward collisions", () => {
    // Prompts are unique per era, so a prompt the operator already wrote into
    // the era being adopted must not be re-created underneath them.
    it("skips a prompt the adopted era already holds", async () => {
      const app = createApp();
      seedQuestion({ status: "active", prompt: "Shared prompt" });
      expect((await endDefault(app)).status).toBe(200);

      // The booth opens a fresh era, and the operator writes the same prompt
      // into it before naming the installation.
      const active = await requireActiveInstallation();
      seedQuestion({
        id: "cccccccc-0000-4000-8000-0000000000b1",
        status: "draft",
        prompt: "Shared prompt",
        installationId: active,
      });

      const res = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Third run", copyQuestions: true }),
      });

      expect(res.status, await res.clone().text()).toBe(201);
      const prompts = [...store.questions.values()]
        .filter((row) => row.installationId === active)
        .map((row) => row.prompt);
      expect(prompts).toEqual(["Shared prompt"]);
    });
  });

  describe("scoped reads", () => {
    it("defaults the message queue to the active installation", async () => {
      // Data belonging to the first era.
      seedMessage({ status: "pending" });
      seedCallSession({ id: "old-session" });

      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      const started = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Fresh" }),
      });
      expect(started.status).toBe(201);

      const res = await app.request("/v1/messages", { headers: operatorHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      // The new era starts with an empty queue even though rows still exist.
      expect(body.items).toHaveLength(0);
    });

    it("returns the historical era when scoped to it explicitly", async () => {
      seedMessage({ status: "approved" });
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      expect(
        (
          await app.request("/v1/installations", {
            method: "POST",
            headers: jsonHeaders(adminHeaders()),
            body: JSON.stringify({ name: "Fresh" }),
          })
        ).status,
      ).toBe(201);

      const res = await app.request(`/v1/messages?installationId=${DEFAULT_INSTALLATION_ID}`, {
        headers: operatorHeaders(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    });

    it("spans every era with installationId=all", async () => {
      seedMessage({ status: "approved" });
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      expect(
        (
          await app.request("/v1/installations", {
            method: "POST",
            headers: jsonHeaders(adminHeaders()),
            body: JSON.stringify({ name: "Fresh" }),
          })
        ).status,
      ).toBe(201);

      const res = await app.request("/v1/messages?installationId=all", {
        headers: operatorHeaders(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    });
  });

  describe("hard purge", () => {
    it("refuses to purge the active installation", async () => {
      const res = await createApp().request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ confirmName: "Installation 1" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "installation_active" });
    });

    it("refuses when the confirmation name does not match", async () => {
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ confirmName: "wrong name" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "name_mismatch" });
      expect(store.installations.get(DEFAULT_INSTALLATION_ID)).toBeDefined();
    });

    it("deletes the era's rows and its unreferenced blobs", async () => {
      const file = seedFile({ blobKey: "messages/aa/aaa.flac", sha256: "sha-purge" });
      seedBlobData(file.blobKey, Buffer.from("audio"), file.sha256);
      seedMessage({ status: "approved", audioId: file.id });
      seedCallSession({ id: "s-purge" });
      seedBoothEvent({ type: "call_started" });

      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ confirmName: "Installation 1" }),
      });
      expect(res.status, await res.clone().text()).toBe(200);

      const body = (await res.json()) as {
        rows: Record<string, number>;
        blobsDeleted: number;
        blobsRetained: number;
        blobFailures: string[];
      };
      expect(body.rows.messages).toBe(1);
      expect(body.rows.callSessions).toBe(1);
      expect(body.rows.events).toBe(1);
      expect(body.blobsDeleted).toBe(1);
      expect(body.blobFailures).toHaveLength(0);

      expect(store.installations.get(DEFAULT_INSTALLATION_ID)).toBeUndefined();
      expect(store.messages.size).toBe(0);
      expect(store.callSessions.size).toBe(0);
      expect(store.boothEvents).toHaveLength(0);
      expect(fakeBlobs.has(file.blobKey)).toBe(false);
    });

    it("retains audio still referenced by a question copied into a later era", async () => {
      const file = seedFile({ blobKey: "questions/bb/bbb.flac", sha256: "sha-shared" });
      seedBlobData(file.blobKey, Buffer.from("question audio"), file.sha256);
      seedQuestion({ status: "active", audioId: file.id, prompt: "Carried forward" });

      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      const started = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Second run", copyQuestions: true }),
      });
      expect(started.status, await started.clone().text()).toBe(201);

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ confirmName: "Installation 1" }),
      });
      expect(res.status, await res.clone().text()).toBe(200);

      const body = (await res.json()) as { blobsDeleted: number; blobsRetained: number };
      // The copy shares the blob, so purging the old era must not delete it —
      // doing so would silently mute the live booth.
      expect(body.blobsRetained).toBe(1);
      expect(body.blobsDeleted).toBe(0);
      expect(fakeBlobs.has(file.blobKey)).toBe(true);
    });

    it("404s for an unknown installation", async () => {
      const res = await createApp().request(
        "/v1/installations/11111111-1111-4111-8111-111111111111",
        {
          method: "DELETE",
          headers: jsonHeaders(adminHeaders()),
          body: JSON.stringify({ confirmName: "whatever" }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // The default-scope change is the riskiest part of installations, so cover
  // all three scopes against the aggregates rather than only the list routes.
  describe("scoped stats", () => {
    const startFresh = async (app: ReturnType<typeof createApp>): Promise<string> => {
      expect((await endDefault(app)).status).toBe(200);
      const res = await app.request("/v1/installations", {
        method: "POST",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Fresh" }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };

    // `receivedToday` counts by timestamp rather than status, so it survives
    // the rollover emptying the moderation queue and measures scoping alone.
    const summaryFor = async (
      app: ReturnType<typeof createApp>,
      scope?: string,
    ): Promise<{ receivedToday: number; callsToday: number }> => {
      const qs = scope === undefined ? "" : `?installationId=${scope}`;
      const res = await app.request(`/v1/stats/summary${qs}`, { headers: operatorHeaders() });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as {
        messages: { receivedToday: number };
        calls: { today: number };
      };
      return { receivedToday: body.messages.receivedToday, callsToday: body.calls.today };
    };

    it("isolates active, historical, and all-era aggregates", async () => {
      seedMessage({ id: "aaaaaaaa-0000-4000-8000-0000000000c1", status: "approved" });
      seedCallSession({ id: "old-session", startedAt: new Date() });

      const app = createApp();
      const freshId = await startFresh(app);

      seedMessage({
        id: "aaaaaaaa-0000-4000-8000-0000000000c2",
        status: "approved",
        installationId: freshId,
      });

      // Omitted scope is the active era only.
      expect(await summaryFor(app)).toEqual({ receivedToday: 1, callsToday: 0 });
      // The era we just closed still reads back exactly as it was.
      expect(await summaryFor(app, DEFAULT_INSTALLATION_ID)).toEqual({
        receivedToday: 1,
        callsToday: 1,
      });
      // `all` is the documented escape hatch: the pre-installations behaviour.
      expect(await summaryFor(app, "all")).toEqual({ receivedToday: 2, callsToday: 1 });
    });

    // The summary is cached; keying that cache by era is what stops a rollover
    // from serving the previous era's numbers for the whole TTL.
    it("does not serve one era's cached summary to another", async () => {
      seedMessage({ id: "aaaaaaaa-0000-4000-8000-0000000000c3", status: "approved" });
      const app = createApp();

      expect(await summaryFor(app)).toEqual({ receivedToday: 1, callsToday: 0 });
      const freshId = await startFresh(app);

      expect(await summaryFor(app)).toEqual({ receivedToday: 0, callsToday: 0 });
      expect(await summaryFor(app, freshId)).toEqual({ receivedToday: 0, callsToday: 0 });
      expect(await summaryFor(app, DEFAULT_INSTALLATION_ID)).toEqual({
        receivedToday: 1,
        callsToday: 0,
      });
    });

    it("scopes the overview the same way", async () => {
      seedMessage({ id: "aaaaaaaa-0000-4000-8000-0000000000c4", status: "approved" });
      const app = createApp();
      await startFresh(app);

      const active = await app.request("/v1/stats/overview", { headers: operatorHeaders() });
      expect(active.status, await active.clone().text()).toBe(200);
      const activeBody = (await active.json()) as { messages: { total: number } };
      expect(activeBody.messages.total).toBe(0);

      const all = await app.request("/v1/stats/overview?installationId=all", {
        headers: operatorHeaders(),
      });
      expect(all.status).toBe(200);
      const allBody = (await all.json()) as { messages: { total: number } };
      expect(allBody.messages.total).toBe(1);
    });
  });

  describe("review regressions", () => {
    // A read must never open an era. Between ending one and the booth's next
    // write there is no active installation, and loading a screen used to
    // conjure an unnamed one into existence.
    it("does not create an installation when a scoped read finds none active", async () => {
      const app = createApp();
      expect((await endDefault(app)).status).toBe(200);
      const before = store.installations.size;

      const res = await app.request("/v1/messages", { headers: adminHeaders() });

      expect(res.status).toBe(200);
      expect(store.installations.size).toBe(before);
      const body = (await res.json()) as { items: unknown[] };
      expect(body.items).toEqual([]);
    });

    it("reports 200 with no rows for stats when no era is open", async () => {
      const app = createApp();
      seedMessage({ id: "aaaaaaaa-0000-4000-8000-00000000000a", status: "pending" });
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request("/v1/stats/summary", { headers: adminHeaders() });

      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { messages: { pending: number } };
      expect(body.messages.pending).toBe(0);
    });

    // The blob may already be gone; reporting it as deleted overstates what
    // the purge actually removed.
    it("counts only blobs the purge actually deleted", async () => {
      const app = createApp();
      const file = seedFile({ id: "ffffffff-0000-4000-8000-00000000000f" });
      seedMessage({
        id: "aaaaaaaa-0000-4000-8000-00000000000b",
        audioId: file.id,
        status: "approved",
      });
      // Deliberately do NOT seed the blob bytes: the row exists, the blob does not.
      expect((await endDefault(app)).status).toBe(200);

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "DELETE",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ confirmName: "Installation 1" }),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { blobsDeleted: number; blobFailures: string[] };
      expect(body.blobsDeleted).toBe(0);
      expect(body.blobFailures).toEqual([]);
    });
  });

  describe("scoped export", () => {
    // A file can back several questions once an era copies them forward, so the
    // export filters files through the to-many `questions` relation. Getting
    // that relation name wrong is invisible to a mock that ignores relation
    // filters, but Prisma rejects the query outright.
    it("includes files owned by the era and excludes another era's", async () => {
      const app = createApp();
      const mine = seedFile({ id: "ffffffff-0000-4000-8000-0000000000a1", sha256: "a".repeat(64) });
      const theirs = seedFile({
        id: "ffffffff-0000-4000-8000-0000000000a2",
        sha256: "b".repeat(64),
      });
      seedQuestion({
        id: "cccccccc-0000-4000-8000-0000000000a1",
        prompt: "Mine",
        audioId: mine.id,
      });
      seedQuestion({
        id: "cccccccc-0000-4000-8000-0000000000a2",
        prompt: "Theirs",
        audioId: theirs.id,
        installationId: "22222222-2222-4222-8222-222222222222",
      });
      seedBlobData(mine.blobKey, Buffer.from("mine"));
      seedBlobData(theirs.blobKey, Buffer.from("theirs"));

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}/export`, {
        headers: adminHeaders(),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      const entries = readTar(Buffer.from(await res.arrayBuffer()));
      const dump = JSON.parse(
        entries.find((entry) => entry.name === "data.json")?.data.toString("utf8") ?? "{}",
      ) as { file?: { id: string }[]; question?: { id: string }[] };
      expect(dump.file?.map((row) => row.id)).toEqual([mine.id]);
      expect(dump.question?.map((row) => row.id)).toEqual(["cccccccc-0000-4000-8000-0000000000a1"]);
    });

    // A scoped archive is handed around (the purge flow offers it as a safety
    // copy), so it must not carry the instance's credentials or the whole
    // staff directory along with one era's recordings.
    it("withholds credential tables and unrelated operators", async () => {
      const app = createApp();
      seedMobileDevice();
      store.users.set("operator-9", {
        id: "operator-9",
        oidcSub: "operator-9",
        email: "stranger@example.com",
        name: "Stranger",
        groups: ["operators"],
        isAdmin: false,
        picture: null,
      });

      const res = await app.request(`/v1/installations/${DEFAULT_INSTALLATION_ID}/export`, {
        headers: adminHeaders(),
      });

      expect(res.status, await res.clone().text()).toBe(200);
      const entries = readTar(Buffer.from(await res.arrayBuffer()));
      const dump = JSON.parse(
        entries.find((entry) => entry.name === "data.json")?.data.toString("utf8") ?? "{}",
      ) as Record<string, unknown[]>;
      expect(dump.mobileDevice).toEqual([]);
      expect(dump.apiToken).toEqual([]);
      expect(dump.metricFilter).toEqual([]);
      // Nothing in this era points at an operator, so none travel with it.
      expect(dump.operatorUser).toEqual([]);
    });
  });

  describe("metadata", () => {
    it("updates name, notes, and location", async () => {
      const res = await createApp().request(`/v1/installations/${DEFAULT_INSTALLATION_ID}`, {
        method: "PATCH",
        headers: jsonHeaders(adminHeaders()),
        body: JSON.stringify({ name: "Renamed", notes: "A note", location: "Toronto" }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await res.json()).toMatchObject({
        name: "Renamed",
        notes: "A note",
        location: "Toronto",
      });
    });
  });
});
