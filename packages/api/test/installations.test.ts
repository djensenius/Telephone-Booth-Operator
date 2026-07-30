import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { resetInstallationCacheForTests } from "../src/lib/installation.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { fakeBlobs, resetFakeAzure, seedBlobData } from "./support/fake-azure.js";
import {
  DEFAULT_INSTALLATION_ID,
  resetFakeDb,
  seedBoothEvent,
  seedCallSession,
  seedFile,
  seedMessage,
  seedQuestion,
  store,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = (): void => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetInstallationCacheForTests();
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

    it("404s for an unknown installation", async () => {
      const res = await createApp().request(
        "/v1/installations/11111111-1111-4111-8111-111111111111/end",
        { method: "POST", headers: jsonHeaders(adminHeaders()), body: JSON.stringify({}) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("starting a new installation", () => {
    it("refuses while one is still active", async () => {
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

    it("copies questions forward when asked, sharing the same blob", async () => {
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

      // The copy points at a distinct File row that reuses the same blob, so
      // no audio is re-uploaded.
      const copiedFile = store.files.get(carried[0]!.audioId);
      expect(copiedFile).toBeDefined();
      expect(copiedFile?.id).not.toBe(file.id);
      expect(copiedFile?.blobKey).toBe(file.blobKey);
    });
  });

  describe("scoped reads", () => {
    it("defaults stats to the active installation and excludes the previous era", async () => {
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

    it("retains a blob still referenced by a question copied into a later era", async () => {
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
