import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { runModeration, runTranscription, type PipelineDeps } from "../src/lib/ai/pipeline.js";
import type { ModerationProvider, TranscriptionProvider } from "../src/lib/ai/types.js";
import { fakeDb } from "./support/fake-db.js";
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
    moderationProvider: "openai",
    moderationOpenAiModel: "omni-moderation-latest",
    moderationMacAppUrl: null,
    moderationMacAppToken: null,
    openAiApiKey: "sk-test",
    openAiBaseUrl: "https://api.openai.com",
    autoDecisionMode: "always_pending",
    autoRejectThreshold: 0.85,
    autoApproveThreshold: 0.15,
    sweeperIntervalSeconds: 60,
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
});

describe("AI pipeline", () => {
  beforeEach(() => {
    resetFakeDb();
    resetFakeAzure();
  });

  it("runs transcription then moderation and leaves the message pending under always_pending", async () => {
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

  it("auto-rejects when moderation flags the transcript in auto_reject mode", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: fakeModeration({
          flagged: true,
          recommendation: "reject",
          maxScore: 0.92,
          reasonSummary: "hate",
        }),
        config: { autoDecisionMode: "auto_reject" } as never,
      }),
    });
    const message = await fakeDb.message.findUnique({ where: { id }, include: { audio: true } });
    const withRelations = message as unknown as {
      status: string;
      notes: string | null;
      decidedById: string | null;
      decidedAt: Date | null;
    };
    expect(withRelations.status).toBe("rejected");
    expect(withRelations.decidedById).toBeNull();
    expect(withRelations.decidedAt).not.toBeNull();
    expect(withRelations.notes).toMatch(/auto-rejected/);
  });

  it("auto-approves clean content in auto_both mode", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: fakeModeration({
          flagged: false,
          recommendation: "approve",
          maxScore: 0.02,
        }),
        config: { autoDecisionMode: "auto_both" } as never,
      }),
    });
    const message = await fakeDb.message.findUnique({ where: { id }, include: { audio: true } });
    const withRelations = message as unknown as { status: string; notes: string | null };
    expect(withRelations.status).toBe("approved");
    expect(withRelations.notes).toMatch(/auto-approved/);
  });

  it("leaves status pending in auto_both when moderation is borderline", async () => {
    const id = await seedReceivedMessage();
    await runTranscription({
      messageId: id,
      deps: baseDeps({
        moderationProvider: fakeModeration({
          flagged: false,
          recommendation: "review",
          maxScore: 0.4,
        }),
        config: { autoDecisionMode: "auto_both" } as never,
      }),
    });
    const message = await fakeDb.message.findUnique({ where: { id }, include: { audio: true } });
    expect((message as unknown as { status: string }).status).toBe("pending");
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
    expect(withRelations.moderations[0]?.error).toContain("upstream blew up");
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
    expect(withRelations.transcriptions[0]?.error).toContain("upstream blew up");
    expect(withRelations.moderations).toHaveLength(0);
  });
});
