// AI orchestration: transcription → moderation → optional auto-decision.
//
// The pipeline is in-process and fire-and-forget:
//   - `POST /v1/messages/:id/complete` calls `kickPipelineForMessage(id)` via
//     `setImmediate`. Errors are caught here so they never reject the request.
//   - A separate recovery sweeper (see `start-ai-sweeper.ts`) reprocesses
//     `received` messages that have no successful transcription, which covers
//     server restarts mid-flight.

import { generateSasUrl } from "../azure-blob.js";
import { wsBroadcaster } from "../broadcaster.js";
import { db } from "../db.js";
import { serializeMessage } from "../serializers.js";
import { resolveAiConfig, type AiConfig } from "./config.js";
import { buildModerationProvider, buildTranscriptionProvider } from "./factory.js";
import type { ModerationProvider, TranscriptionProvider } from "./types.js";

const TRANSCRIPT_PREVIEW_LIMIT = 80;

const previewTranscript = (text: string): string => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length <= TRANSCRIPT_PREVIEW_LIMIT
    ? trimmed
    : `${trimmed.slice(0, TRANSCRIPT_PREVIEW_LIMIT - 1)}…`;
};

const log = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void => {
  // Pino is in the package's dep list but the rest of the codebase logs via
  // console.* (see other routes). Keep parity and never include the full
  // transcript in the payload — fields should already be redacted.
  const payload = { event, ...fields };
  if (level === "info") console.log(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.error(JSON.stringify(payload));
};

export interface PipelineDeps {
  readonly config: AiConfig;
  readonly transcriptionProvider: TranscriptionProvider | null;
  readonly moderationProvider: ModerationProvider | null;
}

export const buildDefaultPipelineDeps = (): PipelineDeps => {
  const config = resolveAiConfig();
  return {
    config,
    transcriptionProvider: buildTranscriptionProvider(config),
    moderationProvider: buildModerationProvider(config),
  };
};

const loadMessage = async (messageId: string) =>
  db.message.findUnique({
    where: { id: messageId },
    include: { audio: true },
  });

const broadcastMessage = async (messageId: string): Promise<void> => {
  const full = await db.message.findUnique({
    where: { id: messageId },
    include: {
      audio: true,
      transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      moderations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!full) return;
  const serialized = serializeMessage(full);
  wsBroadcaster.broadcast({ kind: "message", message: serialized });
};

const applyAutoDecision = async (
  messageId: string,
  deps: PipelineDeps,
  moderationOutcome: {
    recommendation: "approve" | "review" | "reject";
    flagged: boolean;
    maxScore: number;
    reasonSummary?: string;
  },
): Promise<void> => {
  const { autoDecisionMode, autoRejectThreshold, autoApproveThreshold } = deps.config;
  if (autoDecisionMode === "always_pending") {
    await db.message.update({ where: { id: messageId }, data: { status: "pending" } });
    return;
  }
  const reasonNote =
    moderationOutcome.reasonSummary ?? `score ${moderationOutcome.maxScore.toFixed(2)}`;
  if (
    moderationOutcome.recommendation === "reject" ||
    moderationOutcome.flagged ||
    moderationOutcome.maxScore >= autoRejectThreshold
  ) {
    await db.message.update({
      where: { id: messageId },
      data: {
        status: "rejected",
        decidedAt: new Date(),
        decidedById: null,
        notes: `auto-rejected by moderation: ${reasonNote}`,
      },
    });
    return;
  }
  if (
    autoDecisionMode === "auto_both" &&
    !moderationOutcome.flagged &&
    moderationOutcome.maxScore <= autoApproveThreshold
  ) {
    await db.message.update({
      where: { id: messageId },
      data: {
        status: "approved",
        decidedAt: new Date(),
        decidedById: null,
        notes: `auto-approved by moderation: ${reasonNote}`,
      },
    });
    return;
  }
  await db.message.update({ where: { id: messageId }, data: { status: "pending" } });
};

export interface RunTranscriptionOptions {
  readonly messageId: string;
  readonly deps?: PipelineDeps;
  readonly requestedByUserId?: string | null;
  // When true, the function only runs the transcription step and does not
  // trigger moderation or any auto-decision. Currently reserved for callers
  // that want to re-transcribe without disturbing the existing moderation
  // verdict; the manual /moderate route runs moderation directly instead.
  readonly skipDownstream?: boolean;
}

export type TranscriptionResult =
  | { outcome: "created"; transcriptionId: string }
  | { outcome: "skipped"; existingId: string }
  | { outcome: "not_found" };

export const runTranscription = async (
  opts: RunTranscriptionOptions,
): Promise<TranscriptionResult> => {
  const deps = opts.deps ?? buildDefaultPipelineDeps();
  const provider = deps.transcriptionProvider;
  const message = await loadMessage(opts.messageId);
  if (!message) return { outcome: "not_found" };

  if (!provider) {
    const failed = await db.transcription.create({
      data: {
        messageId: message.id,
        provider: deps.config.transcriptionProvider,
        model: null,
        status: "failed",
        error: "transcription provider disabled",
        requestedById: opts.requestedByUserId ?? null,
        completedAt: new Date(),
      },
    });
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: failed.id };
  }

  // Guard: only one active pending transcription per message at a time.
  const staleThresholdMs = deps.config.sweeperStaleThresholdSeconds * 1000;
  const existingPending = await db.transcription.findFirst({
    where: { messageId: message.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (existingPending) {
    const age = Date.now() - existingPending.createdAt.getTime();
    if (age < staleThresholdMs) {
      log("info", "ai.transcription.skipped", {
        messageId: message.id,
        reason: "pending transcription already active",
        existingId: existingPending.id,
        ageMs: age,
      });
      return { outcome: "skipped", existingId: existingPending.id };
    }
    // The existing pending row is older than the stale threshold — the
    // original provider call likely crashed. Mark it failed and proceed.
    await db.transcription.update({
      where: { id: existingPending.id },
      data: {
        status: "failed",
        error: "stale — superseded by newer attempt",
        completedAt: new Date(),
      },
    });
    log("warn", "ai.transcription.stale_superseded", {
      messageId: message.id,
      supersededId: existingPending.id,
      ageMs: age,
    });
  }

  if (message.audio.sizeBytes > 0 && message.audio.sizeBytes > deps.config.maxAudioBytes) {
    const failed = await db.transcription.create({
      data: {
        messageId: message.id,
        provider: provider.name,
        model: provider.model,
        status: "failed",
        error: `audio too large: ${message.audio.sizeBytes} bytes exceeds ${deps.config.maxAudioBytes} limit`,
        requestedById: opts.requestedByUserId ?? null,
        completedAt: new Date(),
      },
    });
    log("warn", "ai.transcription.rejected_size", {
      messageId: message.id,
      sizeBytes: message.audio.sizeBytes,
      maxBytes: deps.config.maxAudioBytes,
    });
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: failed.id };
  }

  const pending = await db.transcription.create({
    data: {
      messageId: message.id,
      provider: provider.name,
      model: provider.model,
      status: "pending",
      durationMs: message.audio.durationMs,
      requestedById: opts.requestedByUserId ?? null,
    },
  });
  await broadcastMessage(message.id);

  const startedAt = Date.now();
  try {
    const sas = generateSasUrl(message.audio.blobKey, { permissions: "r" });
    const result = await provider.transcribe({
      audioUrl: sas.url,
      sha256: message.audio.sha256,
      durationMs: message.audio.durationMs,
    });
    await db.transcription.update({
      where: { id: pending.id },
      data: {
        status: "succeeded",
        text: result.text,
        language: result.language,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
    log("info", "ai.transcription.completed", {
      messageId: message.id,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
      preview: previewTranscript(result.text),
    });
    await broadcastMessage(message.id);
    if (!opts.skipDownstream) {
      if (result.text.trim().length > 0) {
        await runModeration({
          messageId: message.id,
          transcriptionId: pending.id,
          deps,
          requestedByUserId: null,
        });
      } else {
        // Silent recording: there is nothing to moderate, but we still want
        // the message in the operator queue rather than stuck in "received".
        await db.message.update({ where: { id: message.id }, data: { status: "pending" } });
        await broadcastMessage(message.id);
      }
    }
    return { outcome: "created", transcriptionId: pending.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "transcription failed";
    await db.transcription.update({
      where: { id: pending.id },
      data: {
        status: "failed",
        error: reason,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
    log("error", "ai.transcription.failed", {
      messageId: message.id,
      provider: provider.name,
      reason,
    });
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: pending.id };
  }
};

export interface RunModerationOptions {
  readonly messageId: string;
  readonly transcriptionId?: string;
  readonly deps?: PipelineDeps;
  readonly requestedByUserId: string | null;
}

const findLatestTranscription = async (messageId: string) =>
  db.transcription.findFirst({
    where: { messageId, status: "succeeded" },
    orderBy: { createdAt: "desc" },
  });

export const runModeration = async (opts: RunModerationOptions): Promise<string | null> => {
  const deps = opts.deps ?? buildDefaultPipelineDeps();
  const provider = deps.moderationProvider;

  const transcription = opts.transcriptionId
    ? await db.transcription.findUnique({ where: { id: opts.transcriptionId } })
    : await findLatestTranscription(opts.messageId);
  if (
    !transcription ||
    transcription.status !== "succeeded" ||
    !transcription.text ||
    transcription.text.trim().length === 0
  ) {
    return null;
  }

  if (!provider) {
    const failed = await db.moderation.create({
      data: {
        messageId: opts.messageId,
        transcriptionId: transcription.id,
        provider: deps.config.moderationProvider,
        model: null,
        status: "failed",
        error: "moderation provider disabled",
        requestedById: opts.requestedByUserId,
        completedAt: new Date(),
      },
    });
    // Moderation is disabled — advance the message into the operator queue
    // anyway so it doesn't get stranded in "received". Only flip the status
    // if it is still "received" so we don't clobber an operator decision on
    // a manual re-run.
    const current = await db.message.findUnique({
      where: { id: opts.messageId },
      select: { status: true },
    });
    if (current?.status === "received") {
      await db.message.update({ where: { id: opts.messageId }, data: { status: "pending" } });
    }
    await broadcastMessage(opts.messageId);
    return failed.id;
  }

  const pending = await db.moderation.create({
    data: {
      messageId: opts.messageId,
      transcriptionId: transcription.id,
      provider: provider.name,
      model: provider.model,
      status: "pending",
      requestedById: opts.requestedByUserId,
    },
  });
  await broadcastMessage(opts.messageId);

  const startedAt = Date.now();
  try {
    const result = await provider.moderate({ text: transcription.text });
    await db.moderation.update({
      where: { id: pending.id },
      data: {
        status: "succeeded",
        flagged: result.flagged,
        recommendation: result.recommendation,
        maxScore: result.maxScore,
        categories: result.categories,
        reasonSummary: result.reasonSummary ?? null,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
    log("info", "ai.moderation.completed", {
      messageId: opts.messageId,
      provider: provider.name,
      recommendation: result.recommendation,
      maxScore: result.maxScore,
      latencyMs: Date.now() - startedAt,
    });
    await applyAutoDecision(opts.messageId, deps, result);
    await broadcastMessage(opts.messageId);
    return pending.id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "moderation failed";
    await db.moderation.update({
      where: { id: pending.id },
      data: {
        status: "failed",
        error: reason,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
    // Moderation upstream failed — don't strand the recording. Advance the
    // message into the operator queue if it is still "received" so a
    // transient provider outage doesn't hide messages from the operator.
    const current = await db.message.findUnique({
      where: { id: opts.messageId },
      select: { status: true },
    });
    if (current?.status === "received") {
      await db.message.update({ where: { id: opts.messageId }, data: { status: "pending" } });
    }
    log("error", "ai.moderation.failed", {
      messageId: opts.messageId,
      provider: provider.name,
      reason,
    });
    await broadcastMessage(opts.messageId);
    return pending.id;
  }
};

// Public fire-and-forget entrypoint used by `POST /v1/messages/:id/complete`
// and the recovery sweeper. Errors are caught and logged; callers never await.
export const kickPipelineForMessage = (messageId: string): void => {
  setImmediate(() => {
    void runTranscription({ messageId }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "pipeline failed";
      log("error", "ai.pipeline.unhandled", { messageId, reason });
    });
  });
};
