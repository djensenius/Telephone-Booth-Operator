import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));

import { findStrandedMessages } from "../src/lib/ai/sweeper.js";
import { fakeDb, resetFakeDb, seedMessage } from "./support/fake-db.js";

const STALE_MS = 300_000;

const seedTranscription = async (
  messageId: string,
  status: "pending" | "succeeded" | "failed",
  createdAt = new Date(),
) => {
  const row = await fakeDb.transcription.create({
    data: {
      messageId,
      provider: "openai",
      model: "whisper-1",
      status,
      durationMs: 3000,
      requestedById: null,
    },
  });
  await fakeDb.transcription.update({ where: { id: row.id }, data: { createdAt } });
  return row;
};

describe("ai sweeper recovery scan", () => {
  beforeEach(() => {
    resetFakeDb();
  });

  // A completed upload now lands in `pending`, so recovery must not be scoped
  // to the legacy `received` state or in-process transcription would never be
  // retried after a restart.
  it("recovers a pending message whose transcription kick was lost", async () => {
    const message = seedMessage({ status: "pending" });
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).toContain(message.id);
  });

  it("still recovers legacy received messages", async () => {
    const message = seedMessage({ status: "received" });
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).toContain(message.id);
  });

  it("recovers a transcription left pending past the stale threshold", async () => {
    const message = seedMessage({ status: "pending" });
    await seedTranscription(message.id, "pending", new Date(Date.now() - STALE_MS - 1000));
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).toContain(message.id);
  });

  it("leaves a freshly pending transcription alone", async () => {
    const message = seedMessage({ status: "pending" });
    await seedTranscription(message.id, "pending");
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).not.toContain(message.id);
  });

  it("does not retry a failed attempt forever", async () => {
    // The message is already visible in the operator queue, so a completed
    // (failed) attempt is left for an explicit operator re-run rather than
    // being retried every interval.
    const message = seedMessage({ status: "pending" });
    await seedTranscription(message.id, "failed");
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).not.toContain(message.id);
  });

  it("ignores messages an operator already decided", async () => {
    const approved = seedMessage({ status: "approved" });
    const rejected = seedMessage({ status: "rejected" });
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).not.toContain(approved.id);
    expect(stranded).not.toContain(rejected.id);
  });

  it("ignores messages still uploading", async () => {
    const uploading = seedMessage({ status: "uploading" });
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).not.toContain(uploading.id);
  });

  it("leaves a succeeded transcription alone", async () => {
    const message = seedMessage({ status: "pending" });
    await seedTranscription(message.id, "succeeded");
    const stranded = await findStrandedMessages(20, STALE_MS);
    expect(stranded).not.toContain(message.id);
  });
});
