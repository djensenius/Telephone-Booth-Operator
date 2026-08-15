import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import {
  runModeration,
  runTranslationThenModeration,
  runTranscription,
  type PipelineDeps,
} from "../src/lib/ai/pipeline.js";
import { resetApnsSenderForTests, setApnsSenderForTests } from "../src/lib/apns.js";
import { wsBroadcaster, type WsEnvelope } from "../src/lib/broadcaster.js";
import { resetPushEventStateForTests } from "../src/lib/push-events.js";
import type { ModerationProvider, TranscriptionProvider } from "../src/lib/ai/types.js";
import { fakeDb, seedMobileDevice, store } from "./support/fake-db.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb } from "./support/fake-db.js";

const seedReceivedMessage = async (): Promise<string> => {
  const file = await fakeDb.file.create({
    data: {
      blobContainer: "messages",
      blobKey: "messages/aa/test.flac",
      sha256: "a".repeat(64),
      sizeBytes: 1234,
      durationMs: 3000,
      contentType: "audio/flac",
    },
  });
  const message = await fakeDb.message.create({
    data: { status: "received", audioId: file.id },
  });
  return message.id;
};

const fakeTranscription = (text: string): TranscriptionProvider => ({
  name: "openai",
  model: "whisper-1",
  transcribe: vi.fn(async () => ({ text, language: "en" })),
});

const fakeModeration = (result: {
  flagged: boolean;
  recommendation: "approve" | "review" | "reject";
  maxScore: number;
  reasonSummary?: string;
}): ModerationProvider => ({
  name: "openai",
  model: "omni-moderation-latest",
  moderate: vi.fn(async () => ({
    flagged: result.flagged,
    recommendation: result.recommendation,
    maxScore: result.maxScore,
    categories: { hate: result.maxScore },
    ...(result.reasonSummary === undefined ? {} : { reasonSummary: result.reasonSummary }),
  })),
});

const baseDeps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
  config: {
    transcriptionProvider: "openai",
    transcriptionOpenAiModel: "whisper-1",
    transcriptionMacAppUrl: null,
    transcriptionMacAppToken: null,
    translationProvider: "disabled",
    translationOpenAiModel: "gpt-4o-mini",
    translationMacAppUrl: null,
    translationMacAppToken: null,
    moderationProvider: "openai",
    moderationOpenAiModel: "omni-moderation-latest",
    moderationMacAppUrl: null,
    moderationMacAppToken: null,
    openAiApiKey: "sk-test",
    openAiBaseUrl: "https://api.openai.com",
    moderationRejectThreshold: 0.85,
    moderationApproveThreshold: 0.15,
    sweeperIntervalSeconds: 60,
    maxAudioBytes: 26_214_400,
    sweeperStaleThresholdSeconds: 300,
    ...(overrides.config ?? {}),
  },
  transcriptionProvider:
    "transcriptionProvider" in overrides
      ? (overrides.transcriptionProvider ?? null)
      : fakeTranscription("hello"),
  moderationProvider:
    "moderationProvider" in overrides
      ? (overrides.moderationProvider ?? null)
      : fakeModeration({ flagged: false, recommendation: "approve", maxScore: 0.05 }),
  translationProvider:
    "translationProvider" in overrides ? (overrides.translationProvider ?? null) : null,
});

describe("AI pipeline", () => {
  beforeEach(() => {
    resetFakeDb();
    resetFakeAzure();
    resetApnsSenderForTests();
    resetPushEventStateForTests();
  });

  it("runs transcription then moderation and always leaves the message pending for a human", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({ messageId: id, deps: baseDeps() });

    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      transcriptions: Array<{ status: string; text: string | null }>;
      moderations: Array<{ status: string; recommendation: string | null }>;
    };
    expect(withRelations.status).toBe("pending");
    expect(withRelations.transcriptions[0]?.status).toBe("succeeded");
    expect(withRelations.transcriptions[0]?.text).toBe("hello");
    expect(withRelations.moderations[0]?.status).toBe("succeeded");
    expect(withRelations.moderations[0]?.recommendation).toBe("approve");
  });

  it("writes a failed transcription row when the transcription provider is disabled", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        transcriptionProvider: null,
        config: { transcriptionProvider: "disabled" } as never,
      }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      transcriptions: Array<{ status: string; error: string | null; provider: string }>;
    };
    expect(withRelations.transcriptions[0]?.status).toBe("failed");
    expect(withRelations.transcriptions[0]?.error).toMatch(/disabled/);
  });

  it("does not append a disabled result after a newer transcription wins the lock", async () => {
    const id = await seedReceivedMessage();
    await fakeDb.transcription.create({
      data: { messageId: id, provider: "openai", status: "succeeded", text: "original" },
    });
    const findFirst = fakeDb.transcription.findFirst;
    let newerId = "";
    vi.spyOn(fakeDb.transcription, "findFirst").mockImplementationOnce(async (args) => {
      const snapshot = await findFirst(args);
      const newer = await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "newer",
          createdAt: new Date(Date.now() + 1_000),
        },
      });
      newerId = newer.id;
      return snapshot;
    });

    const result = await runTranscription({
      messageId: id,
      deps: baseDeps({
        transcriptionProvider: null,
        config: { transcriptionProvider: "disabled" } as never,
      }),
    });

    expect(result).toEqual({ outcome: "skipped", existingId: newerId });
    const rows = [...store.transcriptions.values()].filter((row) => row.messageId === id);
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(0);
  });

  it("invalidates prior moderation when in-process transcription replaces the reviewed text", async () => {
    const id = await seedReceivedMessage();
    const old = await fakeDb.transcription.create({
      data: { messageId: id, provider: "openai", status: "succeeded", text: "old" },
    });
    const moderation = await fakeDb.moderation.create({
      data: {
        messageId: id,
        transcriptionId: old.id,
        provider: "openai",
        status: "succeeded",
        flagged: false,
        recommendation: "approve",
      },
    });

    await runTranscription({
      messageId: id,
      deps: baseDeps({ transcriptionProvider: fakeTranscription("new") }),
      skipDownstream: true,
    });

    expect(store.moderations.get(moderation.id)).toMatchObject({
      status: "failed",
      error: "superseded_by_transcription",
    });
  });

  it("never auto-rejects even when moderation flags the transcript; a human still decides", async () => {
    const id = await seedReceivedMessage();
    seedMobileDevice({ userId: "operator-1", platform: "ios" });
    const pushes: string[] = [];
    setApnsSenderForTests({
      send: async (_userId, notification) => {
        pushes.push(notification.preferenceKey);
      },
    });
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: fakeModeration({
          flagged: true,
          recommendation: "reject",
          maxScore: 0.92,
          reasonSummary: "hate",
        }),
      }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      notes: string | null;
      decidedById: string | null;
      decidedAt: Date | null;
      moderations: Array<{ recommendation: string | null; flagged: boolean | null }>;
    };
    // The AI suggestion is recorded, but the message stays in the queue for a
    // human decision — no auto-reject, no decidedAt/decidedById stamp.
    expect(withRelations.status).toBe("pending");
    expect(withRelations.decidedById).toBeNull();
    expect(withRelations.decidedAt).toBeNull();
    expect(withRelations.moderations[0]?.recommendation).toBe("reject");
    expect(withRelations.moderations[0]?.flagged).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushes).toContain("messageFlagged");
  });

  it("never auto-approves clean content; the suggestion is advisory only", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: fakeModeration({
          flagged: false,
          recommendation: "approve",
          maxScore: 0.02,
        }),
      }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      decidedAt: Date | null;
      moderations: Array<{ recommendation: string | null }>;
    };
    expect(withRelations.status).toBe("pending");
    expect(withRelations.decidedAt).toBeNull();
    expect(withRelations.moderations[0]?.recommendation).toBe("approve");
  });

  it("runModeration returns null when there is no succeeded transcription", async () => {
    const id = await seedReceivedMessage();
    const result = await runModeration({
      messageId: id,
      deps: baseDeps(),
      requestedByUserId: null,
    });
    expect(result).toBeNull();
  });

  it("advances silent (empty-transcript) messages to pending without running moderation", async () => {
    const id = await seedReceivedMessage();
    const moderation = fakeModeration({
      flagged: false,
      recommendation: "approve",
      maxScore: 0.05,
    });
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        transcriptionProvider: fakeTranscription("   "),
        moderationProvider: moderation,
      }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      transcriptions: Array<{ status: string }>;
      moderations: Array<unknown>;
    };
    expect(withRelations.status).toBe("pending");
    expect(withRelations.transcriptions[0]?.status).toBe("succeeded");
    expect(withRelations.moderations).toHaveLength(0);
    expect(moderation.moderate).not.toHaveBeenCalled();
  });

  it("does not roll back an operator decision when a re-run transcribes silence", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({ messageId: id, deps: baseDeps() });
    await fakeDb.message.update({ where: { id }, data: { status: "approved" } });
    await runTranscription({
      messageId: id,
      deps: baseDeps({ transcriptionProvider: fakeTranscription("   ") }),
    });
    const message = await fakeDb.message.findUnique({ where: { id } });
    expect((message as unknown as { status: string }).status).toBe("approved");
  });

  it("advances messages to pending when moderation is disabled so they reach the operator queue", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: null,
        config: { moderationProvider: "disabled" } as never,
      }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      transcriptions: Array<{ status: string }>;
      moderations: Array<{ status: string; error: string | null }>;
    };
    expect(withRelations.status).toBe("pending");
    expect(withRelations.transcriptions[0]?.status).toBe("succeeded");
    expect(withRelations.moderations).toHaveLength(1);
    expect(withRelations.moderations[0]?.status).toBe("failed");
    expect(withRelations.moderations[0]?.error).toMatch(/disabled/);
  });

  it("does not append a disabled moderation result after the transcription is superseded", async () => {
    const id = await seedReceivedMessage();
    const original = await fakeDb.transcription.create({
      data: {
        messageId: id,
        provider: "openai",
        status: "succeeded",
        text: "first",
      },
    });
    const findFirst = fakeDb.transcription.findFirst;
    vi.spyOn(fakeDb.transcription, "findFirst").mockImplementationOnce(async (args) => {
      await fakeDb.transcription.create({
        data: {
          messageId: id,
          provider: "on_device",
          status: "succeeded",
          text: "newer",
          createdAt: new Date(Date.now() + 1_000),
        },
      });
      return findFirst(args);
    });

    const result = await runModeration({
      messageId: id,
      transcriptionId: original.id,
      deps: baseDeps({
        moderationProvider: null,
        config: { moderationProvider: "disabled" } as never,
      }),
      requestedByUserId: null,
    });

    expect(result).toBeNull();
    expect([...store.moderations.values()].filter((row) => row.messageId === id)).toHaveLength(0);
  });

  it("does not roll back an operator decision when re-running moderation while disabled", async () => {
    const id = await seedReceivedMessage();
    // First pass: real moderation runs and the operator approves.
    await runTranscription({ messageId: id, deps: baseDeps() });
    await fakeDb.message.update({ where: { id }, data: { status: "approved" } });
    // Operator re-runs moderation, but the provider is now disabled.
    await runModeration({
      messageId: id,
      deps: baseDeps({
        moderationProvider: null,
        config: { moderationProvider: "disabled" } as never,
      }),
      requestedByUserId: null,
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as { status: string };
    expect(withRelations.status).toBe("approved");
  });

  it("advances messages to pending when the moderation provider throws so they reach the operator queue", async () => {
    const id = await seedReceivedMessage();
    const moderationProvider: ModerationProvider = {
      name: "openai",
      model: "omni-moderation-latest",
      moderate: vi.fn(async () => {
        throw new Error("upstream blew up");
      }),
    };
    await runTranscription({ messageId: id, deps: baseDeps({ moderationProvider }) });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      moderations: Array<{ status: string; error: string | null }>;
    };
    expect(withRelations.status).toBe("pending");
    expect(withRelations.moderations).toHaveLength(1);
    expect(withRelations.moderations[0]?.status).toBe("failed");
    expect(withRelations.moderations[0]?.error).toContain("unknown_error");
  });

  it("records a transcription failure and does not auto-decide when the provider throws", async () => {
    const id = await seedReceivedMessage();
    const failingProvider: TranscriptionProvider = {
      name: "openai",
      model: "whisper-1",
      transcribe: vi.fn(async () => {
        throw new Error("upstream blew up");
      }),
    };
    await runTranscription({
      messageId: id,
      deps: baseDeps({ transcriptionProvider: failingProvider }),
    });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      status: string;
      transcriptions: Array<{ status: string; error: string | null }>;
      moderations: Array<unknown>;
    };
    expect(withRelations.status).toBe("received");
    expect(withRelations.transcriptions[0]?.status).toBe("failed");
    expect(withRelations.transcriptions[0]?.error).toContain("unknown_error");
    expect(withRelations.moderations).toHaveLength(0);
  });

  it("rejects transcription when audio file exceeds maxAudioBytes", async () => {
    const file = await fakeDb.file.create({
      data: {
        blobContainer: "messages",
        blobKey: "messages/aa/big.flac",
        sha256: "f".repeat(64),
        sizeBytes: 50_000_000,
        durationMs: 3000,
        contentType: "audio/flac",
      },
    });
    const message = await fakeDb.message.create({
      data: { status: "received", audioId: file.id },
    });
    const provider = fakeTranscription("hi");
    await runTranscription({
      messageId: message.id,
      deps: baseDeps({
        transcriptionProvider: provider,
        config: { maxAudioBytes: 25_000_000 } as never,
      }),
    });
    const updated = await fakeDb.message.findUnique({
      where: { id: message.id },
      include: { audio: true, transcriptions: true },
    });
    const withRelations = updated as unknown as {
      transcriptions: Array<{ status: string; error: string | null }>;
    };
    expect(withRelations.transcriptions[0]?.status).toBe("failed");
    expect(withRelations.transcriptions[0]?.error).toMatch(/too large/);
    expect(provider.transcribe).not.toHaveBeenCalled();
  });

  it("skips transcription when a recent pending transcription already exists", async () => {
    const id = await seedReceivedMessage();
    // Seed a pending transcription that is younger than the stale threshold
    await fakeDb.transcription.create({
      data: {
        messageId: id,
        provider: "openai",
        model: "whisper-1",
        status: "pending",
        durationMs: 3000,
        requestedById: null,
      },
    });
    const result = await runTranscription({ messageId: id, deps: baseDeps() });
    expect(result).toEqual({ outcome: "skipped", existingId: expect.any(String) });
    // No new transcription row should have been created
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      transcriptions: Array<{ status: string }>;
    };
    expect(withRelations.transcriptions).toHaveLength(1);
    expect(withRelations.transcriptions[0]?.status).toBe("pending");
  });

  it("supersedes a stale pending transcription and creates a new attempt", async () => {
    const id = await seedReceivedMessage();
    // Seed a pending transcription older than the stale threshold (300s default)
    const staleDate = new Date(Date.now() - 400_000);
    await fakeDb.transcription.create({
      data: {
        messageId: id,
        provider: "openai",
        model: "whisper-1",
        status: "pending",
        durationMs: 3000,
        requestedById: null,
        createdAt: staleDate,
      },
    });
    const result = await runTranscription({ messageId: id, deps: baseDeps() });
    expect(result).toEqual({ outcome: "created", transcriptionId: expect.any(String) });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      transcriptions: Array<{ status: string; error: string | null }>;
    };
    // Should have 2 rows: the stale one marked failed and the new successful one
    expect(withRelations.transcriptions).toHaveLength(2);
    const staleRow = withRelations.transcriptions.find((t) =>
      t.error?.includes("superseded by newer attempt"),
    );
    expect(staleRow?.status).toBe("failed");
    const newRow = withRelations.transcriptions.find((t) => t.status === "succeeded");
    expect(newRow).toBeDefined();
  });

  it("in push mode, marks transcription pending and broadcasts transcription work", async () => {
    const id = await seedReceivedMessage();
    const events: WsEnvelope[] = [];
    const clientId = `test-${Math.random()}`;
    wsBroadcaster.subscribe(clientId, (e) => events.push(e));

    const result = await runTranscription({
      messageId: id,
      deps: baseDeps({
        transcriptionProvider: null,
        config: {
          ...baseDeps().config,
          transcriptionProvider: "push",
        },
      }),
    });
    wsBroadcaster.unsubscribe(clientId);

    expect(result).toEqual({ outcome: "created", transcriptionId: expect.any(String) });
    const message = await fakeDb.message.findUnique({
      where: { id },
      include: { audio: true, transcriptions: true, moderations: true },
    });
    const withRelations = message as unknown as {
      transcriptions: Array<{ status: string; provider: string }>;
    };
    // A pending row is created (not a failed one) so the worker can fill it in.
    expect(withRelations.transcriptions).toHaveLength(1);
    expect(withRelations.transcriptions[0]?.status).toBe("pending");
    expect(withRelations.transcriptions[0]?.provider).toBe("push");
    // The worker is told to transcribe via a `work` envelope.
    const work = events.find((e) => e.kind === "work");
    expect(work).toEqual({ kind: "work", messageId: id, needs: ["transcription"] });
  });

  it("defers moderation until the push translation callback completes", async () => {
    const id = await seedReceivedMessage();
    const transcription = await fakeDb.transcription.create({
      data: {
        messageId: id,
        provider: "push",
        model: null,
        status: "succeeded",
        text: "bonjour",
        language: "fr",
        requestedById: null,
        completedAt: new Date(),
      },
    });
    const events: WsEnvelope[] = [];
    const clientId = `test-${Math.random()}`;
    wsBroadcaster.subscribe(clientId, (e) => events.push(e));

    await runTranslationThenModeration({
      messageId: id,
      transcriptionId: transcription.id,
      deps: baseDeps({
        translationProvider: null,
        moderationProvider: fakeModeration({
          flagged: false,
          recommendation: "approve",
          maxScore: 0.01,
        }),
        config: { translationProvider: "push" } as never,
      }),
    });
    wsBroadcaster.unsubscribe(clientId);

    const updated = await fakeDb.transcription.findUnique({ where: { id: transcription.id } });
    expect(updated?.translationStatus).toBe("pending");
    expect([...store.moderations.values()]).toHaveLength(0);
    expect(events.find((e) => e.kind === "work")).toEqual({
      kind: "work",
      messageId: id,
      needs: ["translation"],
    });
  });

  it("creates reusable pending moderation work in push mode", async () => {
    const id = await seedReceivedMessage();
    await fakeDb.transcription.create({
      data: {
        messageId: id,
        provider: "push",
        model: null,
        status: "succeeded",
        text: "hello",
        language: "en",
        requestedById: null,
        completedAt: new Date(),
      },
    });
    const events: WsEnvelope[] = [];
    const clientId = `test-${Math.random()}`;
    wsBroadcaster.subscribe(clientId, (e) => events.push(e));

    await runModeration({
      messageId: id,
      deps: baseDeps({
        moderationProvider: null,
        config: { moderationProvider: "push" } as never,
      }),
      requestedByUserId: null,
    });
    await runModeration({
      messageId: id,
      deps: baseDeps({
        moderationProvider: null,
        config: { moderationProvider: "push" } as never,
      }),
      requestedByUserId: null,
    });
    wsBroadcaster.unsubscribe(clientId);

    const moderations = [...store.moderations.values()].filter((m) => m.messageId === id);
    expect(moderations).toHaveLength(1);
    expect(moderations[0]).toMatchObject({ status: "pending", provider: "push" });
    expect(events.filter((e) => e.kind === "work")).toHaveLength(2);
  });
});
