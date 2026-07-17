import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createTar, readTar } from "../src/lib/archive.js";
import { createHash } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure, seedBlobData, fakeBlobData } from "./support/fake-azure.js";
import {
  resetFakeDb,
  seedCallSession,
  seedFile,
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
    expect(summary.rows.file).toBe(2);
    expect(summary.blobsUploaded).toBe(2);

    // Data + audio are back.
    expect(store.questions.get(question.id)?.audioId).toBe(questionFile.id);
    expect(store.messages.get(message.id)?.questionId).toBe(question.id);
    expect(store.files.size).toBe(2);
    expect(fakeBlobData.get(questionFile.blobKey)?.toString("utf8")).toBe("question-audio-bytes");
    expect(fakeBlobData.get(messageFile.blobKey)?.toString("utf8")).toBe("message-audio-bytes");
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
