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
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure, seedBlobData, fakeBlobData } from "./support/fake-azure.js";
import {
  resetFakeDb,
  seedCallSession,
  seedFile,
  seedInstruction,
  seedMessage,
  seedQuestion,
  store,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
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

    const importRes = await app.request("/v1/admin/data/import", {
      method: "POST",
      headers: { cookie: cookie2, "content-type": "application/x-tar" },
      body: archive,
    });
    expect(importRes.status).toBe(200);
    const summary = (await importRes.json()) as {
      rows: Record<string, number>;
      blobsUploaded: number;
    };
    expect(summary.rows.question).toBe(1);
    expect(summary.rows.message).toBe(1);
    expect(summary.rows.instruction).toBe(1);
    expect(summary.rows.file).toBe(3);
    expect(summary.blobsUploaded).toBe(3);

    // Data + audio are back.
    expect(store.questions.get(question.id)?.audioId).toBe(questionFile.id);
    expect(store.messages.get(message.id)?.questionId).toBe(question.id);
    expect(store.instructions.get(instruction.id)?.audioId).toBe(instructionFile.id);
    expect(store.files.size).toBe(3);
    expect(fakeBlobData.get(questionFile.blobKey)?.toString("utf8")).toBe("question-audio-bytes");
    expect(fakeBlobData.get(messageFile.blobKey)?.toString("utf8")).toBe("message-audio-bytes");
    expect(fakeBlobData.get(instructionFile.blobKey)?.toString("utf8")).toBe(
      "instruction-audio-bytes",
    );
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
    // An array is not a metadata object; the trail's own schema wins.
    expect(restored?.metadata).toBeNull();
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
