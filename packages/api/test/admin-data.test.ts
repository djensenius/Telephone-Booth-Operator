import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createTar, readTar } from "../src/lib/archive.js";
import { EXPORT_FORMAT } from "../src/lib/data-archive.js";
import { createHash } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetApnsSenderForTests, setApnsSenderForTests } from "../src/lib/apns.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure, seedBlobData, fakeBlobData } from "./support/fake-azure.js";
import {
  DEFAULT_INSTALLATION_ID,
  resetFakeDb,
  seedCallSession,
  seedFile,
  seedInstruction,
  seedMessage,
  seedMobileDevice,
  seedQuestion,
  seedTelemetrySource,
  store,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetApnsSenderForTests();
};

describe("tar archive", () => {
  it("round-trips entries including binary blobs", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"format":"x"}', "utf8") },
      { name: "blobs/abc", data: Buffer.from([0, 1, 2, 3, 255, 254, 253]) },
    ];
    const archive = createTar(entries);
    const read = readTar(archive);
    expect(read).toHaveLength(2);
    expect(read[0]?.name).toBe("manifest.json");
    expect(read[0]?.data.toString("utf8")).toBe('{"format":"x"}');
    expect(read[1]?.name).toBe("blobs/abc");
    expect(Buffer.compare(read[1]?.data ?? Buffer.alloc(0), entries[1]!.data)).toBe(0);
  });
});

describe("admin data export/import", () => {
  beforeEach(setup);

  it("requires authentication", async () => {
    const app = createApp();
    const res = await app.request("/v1/admin/data/export");
    expect(res.status).toBe(401);
  });

  it("exports then restores the database and audio", async () => {
    const app = createApp();
    const cookie = operatorCookie();

    // Seed a question with audio and a message with audio, plus a call.
    const questionAudio = Buffer.from("question-audio-bytes");
    const qSha = createHash("sha256").update(questionAudio).digest("hex");
    const questionFile = seedFile({
      sha256: qSha,
      blobKey: `questions/bb/${qSha}.flac`,
    });
    const question = seedQuestion({ audioId: questionFile.id, status: "active" });
    seedBlobData(questionFile.blobKey, questionAudio, qSha);

    const messageAudio = Buffer.from("message-audio-bytes");
    const mSha = createHash("sha256").update(messageAudio).digest("hex");
    const messageFile = seedFile({ sha256: mSha, blobKey: `messages/cc/${mSha}.flac` });
    const message = seedMessage({ audioId: messageFile.id, questionId: question.id });
    seedBlobData(messageFile.blobKey, messageAudio, mSha);

    const instructionAudio = Buffer.from("instruction-audio-bytes");
    const iSha = createHash("sha256").update(instructionAudio).digest("hex");
    const instructionFile = seedFile({ sha256: iSha, blobKey: `instructions/dd/${iSha}.flac` });
    const instruction = seedInstruction({ audioId: instructionFile.id, status: "active" });
    seedBlobData(instructionFile.blobKey, instructionAudio, iSha);

    seedCallSession({ id: "call-1", startedAt: new Date(), outcome: "recording_completed" });
    const telemetrySource = seedTelemetrySource();

    const exportRes = await app.request("/v1/admin/data/export", { headers: { cookie } });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toBe("application/x-tar");
    const archive = Buffer.from(await exportRes.arrayBuffer());
    expect(archive.byteLength).toBeGreaterThan(0);

    // Wipe the world, then import.
    resetFakeDb();
    resetFakeAzure();
    expect(store.questions.size).toBe(0);
    expect(fakeBlobData.size).toBe(0);
    const cookie2 = operatorCookie();
    seedMobileDevice({
      userId: "operator-1",
      preferences: { messageReceived: false },
    });
    const badges: number[] = [];
    setApnsSenderForTests({
      send: async (_userId, notification) => {
        if (notification.kind === "badge") badges.push(notification.badge);
      },
    });

    const importRes = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie: cookie2, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(importRes.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const summary = (await importRes.json()) as {
      rows: Record<string, number>;
      blobsUploaded: number;
    };
    expect(summary.rows.question).toBe(1);
    expect(summary.rows.message).toBe(1);
    expect(summary.rows.instruction).toBe(1);
    expect(summary.rows.file).toBe(3);
    expect(summary.rows.telemetrySource).toBe(1);
    expect(summary.blobsUploaded).toBe(3);

    // Data + audio are back.
    expect(store.questions.get(question.id)?.audioId).toBe(questionFile.id);
    expect(store.messages.get(message.id)?.questionId).toBe(question.id);
    expect(store.instructions.get(instruction.id)?.audioId).toBe(instructionFile.id);
    expect(store.files.size).toBe(3);
    expect(store.telemetrySources.get(telemetrySource.id)).toMatchObject({
      boothId: "booth-01",
      componentId: "router-01",
      latestSnapshot: null,
    });
    expect(fakeBlobData.get(questionFile.blobKey)?.toString("utf8")).toBe("question-audio-bytes");
    expect(fakeBlobData.get(messageFile.blobKey)?.toString("utf8")).toBe("message-audio-bytes");
    expect(fakeBlobData.get(instructionFile.blobKey)?.toString("utf8")).toBe(
      "instruction-audio-bytes",
    );
    expect(badges.at(-1)).toBe(1);
  });

  it("rejects an authenticated non-admin export with 403", async () => {
    const app = createApp();
    const cookie = operatorCookie({ isAdmin: false });
    const res = await app.request("/v1/admin/data/export", { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("rejects an authenticated non-admin import with 403", async () => {
    const app = createApp();
    const cookie = operatorCookie({ isAdmin: false });
    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: Buffer.from("padding padding padding padding padding padding padding padding pad"),
    });
    expect(res.status).toBe(403);
  });

  it("restores a pre-collapse status snapshot with a window", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const updatedAt = "2026-07-28T12:00:00.000Z";
    // An archive written before status collapsing: no firstSeenAt/repeatCount.
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            // Pinned to 1 on purpose: this is a pre-collapse archive.
            version: 1,
            generatedAt: updatedAt,
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({ boothStatusSnapshot: [{ id: 1, state: "idle", updatedAt }] }),
          "utf8",
        ),
      },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(res.status).toBe(200);

    const restored = store.statuses.find((status) => status.id === 1);
    // The window starts at the report, not at the restore.
    expect(restored?.firstSeenAt.toISOString()).toBe(updatedAt);
    expect(restored?.repeatCount).toBe(1);
  });

  // The manifest arrives inside an uploaded tar, so a malformed optional field
  // has to be an invalid_archive rather than a TypeError surfacing as a 500.
  it("rejects a manifest whose partialInstallationIds is not a string array", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 3,
            generatedAt: "2026-07-29T12:34:56.000Z",
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
            partialInstallationIds: {},
          }),
          "utf8",
        ),
      },
      { name: "data.json", data: Buffer.from("{}", "utf8") },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_archive");
  });

  it("adopts legacy archive rows into one idempotent restored installation", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const generatedAt = "2026-07-29T12:34:56.000Z";
    const questionAudioId = "10000000-0000-4000-8000-000000000001";
    const messageAudioId = "10000000-0000-4000-8000-000000000002";
    const questionId = "20000000-0000-4000-8000-000000000001";
    const messageId = "30000000-0000-4000-8000-000000000001";
    const sessionId = "legacy-call-1";
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 2,
            generatedAt,
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({
            file: [
              {
                id: questionAudioId,
                blobContainer: "booth-recordings",
                blobKey: "questions/legacy-question.flac",
                sha256: "b".repeat(64),
                sizeBytes: 10,
                durationMs: 1000,
                contentType: "audio/flac",
              },
              {
                id: messageAudioId,
                blobContainer: "booth-recordings",
                blobKey: "messages/legacy-message.flac",
                sha256: "c".repeat(64),
                sizeBytes: 20,
                durationMs: 2000,
                contentType: "audio/flac",
              },
            ],
            question: [
              {
                id: questionId,
                prompt: "Legacy restored question?",
                status: "active",
                audioId: questionAudioId,
                createdAt: generatedAt,
                retiredAt: null,
              },
            ],
            callSession: [
              {
                id: sessionId,
                boothId: "booth-1",
                bootId: "boot-1",
                startedAt: generatedAt,
                endedAt: null,
                digitsDialed: null,
                outcome: "recording_completed",
                recordingId: null,
                durationMs: 1234,
                version: null,
              },
            ],
            message: [
              {
                id: messageId,
                status: "pending",
                notes: null,
                questionId,
                audioId: messageAudioId,
                createdAt: generatedAt,
                receivedAt: generatedAt,
                decidedAt: null,
                decidedById: null,
              },
            ],
            boothEvent: [
              {
                id: "legacy-event-row-1",
                eventId: "legacy-event-1",
                boothId: "booth-1",
                bootId: "boot-1",
                type: "call_started",
                occurredAt: generatedAt,
                receivedAt: generatedAt,
                sessionId,
                recordingId: null,
                payload: {},
                version: null,
              },
            ],
            boothStatusSnapshot: [{ id: 42, state: "idle", updatedAt: generatedAt }],
          }),
          "utf8",
        ),
      },
    ]);

    const importOnce = async () =>
      app.request("/v1/admin/data/import", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-tar" },
        body: archive,
      });

    const first = await importOnce();
    expect(first.status).toBe(200);

    const adoptedIds = new Set([
      store.questions.get(questionId)?.installationId,
      store.messages.get(messageId)?.installationId,
      store.callSessions.get(sessionId)?.installationId,
      store.boothEvents.find((event) => event.id === "legacy-event-row-1")?.installationId,
      store.statuses.find((status) => status.id === 42)?.installationId,
    ]);
    expect(adoptedIds.size).toBe(1);
    const restoredId = [...adoptedIds][0];
    expect(restoredId).toEqual(expect.any(String));
    expect(restoredId).not.toBe(DEFAULT_INSTALLATION_ID);
    const restoredInstallation = store.installations.get(restoredId as string);
    expect(restoredInstallation?.name).toBe(`Restored ${generatedAt}`);
    expect(restoredInstallation?.endedAt?.toISOString()).toBe(generatedAt);

    // The adopted era is ended, so it must also be closed out: no message left
    // in the moderation queue, no session left open, no question left live, and
    // counters frozen to match.
    expect(store.messages.get(messageId)?.status).toBe("rejected");
    expect(store.callSessions.get(sessionId)?.endedAt?.toISOString()).toBe(generatedAt);
    expect(store.callSessions.get(sessionId)?.outcome).toBe("installation_ended");
    expect(store.questions.get(questionId)?.status).toBe("archived");
    expect(restoredInstallation?.summary).toMatchObject({
      calls: 1,
      messages: 0,
      allRecordings: 1,
      messagesRejected: 1,
      events: 1,
      firstActivityAt: generatedAt,
    });

    const installationCount = store.installations.size;
    const second = await importOnce();
    expect(second.status).toBe(200);
    expect(store.installations.size).toBe(installationCount);
    expect(store.messages.get(messageId)?.installationId).toBe(restoredId);
  });

  // Only one era may be open at a time, enforced by a partial unique index. A
  // v3 archive carrying its own active era therefore collides with the one the
  // target was seeded with, unless the restore reconciles first.
  it("reconciles the target's active installation when the archive has one", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const incomingId = "44444444-4444-4444-8444-444444444444";
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 3,
            generatedAt: "2026-07-29T12:34:56.000Z",
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({
            installation: [
              {
                id: incomingId,
                name: "Imported era",
                notes: null,
                location: null,
                startedAt: "2026-07-01T00:00:00.000Z",
                endedAt: null,
                endedById: null,
                summary: null,
                createdAt: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });

    expect(res.status, await res.clone().text()).toBe(200);
    // The seeded era is closed, not deleted: a replica still holding it as its
    // cached active id would otherwise fail the next booth write's foreign key.
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.endedAt).toBeInstanceOf(Date);
    const open = [...store.installations.values()].filter((row) => row.endedAt === null);
    expect(open.map((row) => row.id)).toEqual([incomingId]);
  });

  it("closes an active installation that has data instead of discarding it", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    seedMessage({ id: "50000000-0000-4000-8000-000000000001", status: "approved" });
    const incomingId = "55555555-5555-4555-8555-555555555555";
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 3,
            generatedAt: "2026-07-29T12:34:56.000Z",
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({
            installation: [
              {
                id: incomingId,
                name: "Imported era",
                notes: null,
                location: null,
                startedAt: "2026-07-01T00:00:00.000Z",
                endedAt: null,
                endedById: null,
                summary: null,
                createdAt: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });

    expect(res.status, await res.clone().text()).toBe(200);
    // Nothing is orphaned: the era that held data is closed, not deleted.
    expect(store.installations.get(DEFAULT_INSTALLATION_ID)?.endedAt).toBeInstanceOf(Date);
    const open = [...store.installations.values()].filter((row) => row.endedAt === null);
    expect(open.map((row) => row.id)).toEqual([incomingId]);
  });

  it("rejects an empty import body", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: Buffer.alloc(0),
    });
    expect(res.status).toBe(400);
  });

  it("will not let a restore rewrite an existing audit entry", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const createdAt = new Date("2026-07-28T12:00:00.000Z");
    const id = "6f1b0f7c-6f0a-4f3e-9f8a-2a4f0b6d1e11";
    store.auditLogs.push({
      id,
      action: "message.approve",
      targetType: "message",
      targetId: "m1",
      actorType: "operator",
      actorUserId: null,
      actorTokenId: null,
      actorLabel: "operator@example.com",
      ip: "203.0.113.7",
      userAgent: null,
      method: "POST",
      path: "/v1/messages/m1/decision",
      statusCode: 200,
      metadata: null,
      createdAt,
    });

    // A crafted archive claiming the same ID with a rewritten actor.
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 3,
            generatedAt: createdAt.toISOString(),
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({
            auditLog: [
              {
                id,
                action: "message.reject",
                actorType: "anonymous",
                actorLabel: "someone else",
                ip: "198.51.100.4",
                method: "POST",
                path: "/v1/messages/m1/decision",
                statusCode: 403,
                createdAt: createdAt.toISOString(),
              },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(res.status).toBe(200);

    const rows = store.auditLogs.filter((row) => row.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ip).toBe("203.0.113.7");
    expect(rows[0]?.action).toBe("message.approve");
    expect(rows[0]?.actorLabel).toBe("operator@example.com");
    expect(rows[0]?.statusCode).toBe(200);
  });

  it("bounds an oversized audit row coming back through a restore", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const createdAt = new Date("2026-07-28T12:00:00.000Z");
    const id = "7a2c1e8d-3b4f-4a2c-8e1d-9f0a1b2c3d4e";
    const archive = createTar([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: EXPORT_FORMAT,
            version: 3,
            generatedAt: createdAt.toISOString(),
            container: "audio",
            counts: {},
            blobCount: 0,
            missingBlobs: [],
          }),
          "utf8",
        ),
      },
      {
        name: "data.json",
        data: Buffer.from(
          JSON.stringify({
            auditLog: [
              {
                id,
                action: "a".repeat(500),
                actorType: "operator",
                actorLabel: "b".repeat(1000),
                userAgent: "c".repeat(2000),
                method: "POST",
                path: `/v1/${"d".repeat(2000)}`,
                statusCode: 200,
                metadata: ["not", "an", "object"],
                createdAt: createdAt.toISOString(),
              },
            ],
          }),
          "utf8",
        ),
      },
    ]);

    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(res.status).toBe(200);

    const restored = store.auditLogs.find((row) => row.id === id);
    expect(restored?.action.length).toBe(128);
    expect(restored?.actorLabel.length).toBe(320);
    expect(restored?.userAgent?.length).toBe(512);
    expect(restored?.path.length).toBe(512);
    // An array is not a metadata object; the trail's own schema wins. Prisma
    // rejects a plain `null` for a nullable Json column, so the field is left
    // off entirely rather than nulled.
    expect(restored && "metadata" in restored).toBe(false);
  });

  it("rejects a non-archive import body", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-tar" },
      body: Buffer.from("not a tar archive at all, just text padding padding padding padding pad"),
    });
    expect(res.status).toBe(400);
  });
});
