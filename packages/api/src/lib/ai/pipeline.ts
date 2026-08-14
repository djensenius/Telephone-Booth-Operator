// AI orchestration: transcription → moderation → optional auto-decision.
//
// Transcription is *optional enrichment*: `POST /v1/messages/:id/complete`
// puts a landed recording straight into the operator queue (`pending`), and
// nothing here ever gates that. The steps below only attach transcript,
// translation and moderation data to a message that is already reviewable.
//
// The pipeline is in-process and fire-and-forget:
//   - `POST /v1/messages/:id/complete` calls `kickPipelineForMessage(id)` via
//     `setImmediate`, which is a no-op for the `push` / `disabled` providers.
//     Errors are caught here so they never reject the request.
//   - A separate recovery sweeper (see `start-ai-sweeper.ts`) reprocesses
//     legacy `received` messages that have no successful transcription, which
//     covers server restarts mid-flight.

import { createHash } from "node:crypto";
import type { ModerationRecommendation } from "@telephone-booth-operator/shared";
import { generateSasUrl } from "../azure-blob.js";
import { broadcastWork, wsBroadcaster } from "../broadcaster.js";
import { db } from "../db.js";
import { serializeMessage } from "../serializers.js";
import { normalizeTranslationText } from "../translation-text.js";
import { isEnglishLanguage, resolveAiConfig, type AiConfig } from "./config.js";
import {
  buildModerationProvider,
  buildTranscriptionProvider,
  buildTranslationProvider,
} from "./factory.js";
import type { ModerationProvider, TranscriptionProvider, TranslationProvider } from "./types.js";
import { ProviderError } from "./types.js";

// Build a sanitized error string safe for persistence and logging.
// Never includes transcript text, response bodies, or SAS URLs.
const sanitizeError = (error: unknown): string => {
  if (error instanceof ProviderError) {
    return error.message; // Already structured: "provider/code/status"
  }
  if (error instanceof Error) {
    return `unknown_error/${error.name}`;
  }
  return "unknown_error";
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
  readonly translationProvider: TranslationProvider | null;
  readonly moderationProvider: ModerationProvider | null;
}

export const buildDefaultPipelineDeps = (): PipelineDeps => {
  const config = resolveAiConfig();
  return {
    config,
    transcriptionProvider: buildTranscriptionProvider(config),
    translationProvider: buildTranslationProvider(config),
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

// Advance a freshly moderated message into the operator review queue. The AI
// moderation result is only ever an advisory *suggestion*: the Operator never
// auto-approves or auto-rejects. A human operator makes the decision via
// `POST /v1/messages/:id/decision`. We only nudge `received` → `pending` so the
// message surfaces in the queue; any already-decided message is left untouched
// (e.g. re-moderation after a human decision must not reopen it).
export const advanceMessageAfterModeration = async (messageId: string): Promise<void> => {
  await db.message.updateMany({
    where: { id: messageId, status: "received" },
    data: { status: "pending" },
  });
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
  const latestSucceededAtStart = await db.transcription.findFirst({
    where: { messageId: message.id, status: "succeeded" },
    orderBy: { createdAt: "desc" },
  });

  if (!provider) {
    // Push mode: no in-process transcription provider, but a subscribed
    // Transcription app will do the work. Create the pending row and broadcast
    // a `work` event so the app fetches the audio and posts the text back to
    // /v1/worker/messages/:id/transcription. (In a truly disabled config we
    // instead record a failed row below.)
    if (deps.config.transcriptionProvider === "push") {
      const prepared = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Message" WHERE "id" = ${message.id}::uuid FOR UPDATE
        `;
        if (rows.length === 0) return { outcome: "not_found" } as const;
        const latestSucceeded = await tx.transcription.findFirst({
          where: { messageId: message.id, status: "succeeded" },
          orderBy: { createdAt: "desc" },
        });
        if ((latestSucceeded?.id ?? null) !== (latestSucceededAtStart?.id ?? null)) {
          return {
            outcome: "skipped",
            existingId: latestSucceeded?.id ?? "",
          } as const;
        }
        const existing = await tx.transcription.findFirst({
          where: { messageId: message.id, status: "pending" },
          orderBy: { createdAt: "desc" },
        });
        const pending =
          existing ??
          (await tx.transcription.create({
            data: {
              messageId: message.id,
              provider: "push",
              model: null,
              status: "pending",
              durationMs: message.audio.durationMs,
              requestedById: opts.requestedByUserId ?? null,
            },
          }));
        return { outcome: "created", pending } as const;
      });
      if (prepared.outcome === "not_found") return { outcome: "not_found" };
      if (prepared.outcome === "skipped") {
        return { outcome: "skipped", existingId: prepared.existingId };
      }
      await broadcastMessage(message.id);
      broadcastWork(message.id, ["transcription"]);
      return { outcome: "created", transcriptionId: prepared.pending.id };
    }
    const prepared = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${message.id}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return { outcome: "not_found" } as const;
      const latestSucceeded = await tx.transcription.findFirst({
        where: { messageId: message.id, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if ((latestSucceeded?.id ?? null) !== (latestSucceededAtStart?.id ?? null)) {
        return { outcome: "skipped", existingId: latestSucceeded?.id ?? "" } as const;
      }
      const failed = await tx.transcription.create({
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
      return { outcome: "created", failed } as const;
    });
    if (prepared.outcome === "not_found") return { outcome: "not_found" };
    if (prepared.outcome === "skipped") {
      return { outcome: "skipped", existingId: prepared.existingId };
    }
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: prepared.failed.id };
  }

  const staleThresholdMs = deps.config.sweeperStaleThresholdSeconds * 1000;
  const prepared = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${message.id}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return { outcome: "not_found" } as const;

    const latestSucceeded = await tx.transcription.findFirst({
      where: { messageId: message.id, status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    if ((latestSucceeded?.id ?? null) !== (latestSucceededAtStart?.id ?? null)) {
      return { outcome: "skipped", existingId: latestSucceeded?.id ?? "" } as const;
    }

    const existingPending = await tx.transcription.findFirst({
      where: { messageId: message.id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    let superseded: { id: string; ageMs: number } | null = null;
    if (existingPending) {
      const ageMs = Date.now() - existingPending.createdAt.getTime();
      if (ageMs < staleThresholdMs) {
        return { outcome: "skipped", existingId: existingPending.id, ageMs } as const;
      }
      await tx.transcription.update({
        where: { id: existingPending.id },
        data: {
          status: "failed",
          error: "stale — superseded by newer attempt",
          completedAt: new Date(),
        },
      });
      superseded = { id: existingPending.id, ageMs };
    }

    if (message.audio.sizeBytes > 0 && message.audio.sizeBytes > deps.config.maxAudioBytes) {
      const failed = await tx.transcription.create({
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
      return { outcome: "failed", transcriptionId: failed.id, superseded } as const;
    }

    const pending = await tx.transcription.create({
      data: {
        messageId: message.id,
        provider: provider.name,
        model: provider.model,
        status: "pending",
        durationMs: message.audio.durationMs,
        requestedById: opts.requestedByUserId ?? null,
      },
    });
    return { outcome: "pending", pending, superseded } as const;
  });

  if (prepared.outcome === "not_found") return { outcome: "not_found" };
  if (prepared.outcome === "skipped") {
    log("info", "ai.transcription.skipped", {
      messageId: message.id,
      reason:
        "ageMs" in prepared
          ? "pending transcription already active"
          : "newer transcription recorded",
      existingId: prepared.existingId,
      ...("ageMs" in prepared ? { ageMs: prepared.ageMs } : {}),
    });
    return { outcome: "skipped", existingId: prepared.existingId };
  }
  if (prepared.superseded) {
    log("warn", "ai.transcription.stale_superseded", {
      messageId: message.id,
      supersededId: prepared.superseded.id,
      ageMs: prepared.superseded.ageMs,
    });
  }
  if (prepared.outcome === "failed") {
    log("warn", "ai.transcription.rejected_size", {
      messageId: message.id,
      sizeBytes: message.audio.sizeBytes,
      maxBytes: deps.config.maxAudioBytes,
    });
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: prepared.transcriptionId };
  }
  const { pending } = prepared;
  await broadcastMessage(message.id);

  const startedAt = Date.now();
  try {
    const sas = generateSasUrl(message.audio.blobKey, { permissions: "r" });
    const result = await provider.transcribe({
      audioUrl: sas.url,
      sha256: message.audio.sha256,
      durationMs: message.audio.durationMs,
    });
    const finalized = await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Message" WHERE "id" = ${message.id}::uuid FOR UPDATE
      `;
      const updated = await tx.transcription.updateMany({
        where: { id: pending.id, status: "pending", provider: provider.name },
        data: {
          status: "succeeded",
          text: result.text,
          language: result.language,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
      if (updated.count > 0) {
        await tx.moderation.updateMany({
          where: {
            messageId: message.id,
            status: { in: ["pending", "succeeded"] },
          },
          data: {
            status: "failed",
            error: "superseded_by_transcription",
            completedAt: new Date(),
          },
        });
      }
      return updated;
    });
    if (finalized.count === 0) return { outcome: "created", transcriptionId: pending.id };
    log("info", "ai.transcription.completed", {
      messageId: message.id,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
    });
    await broadcastMessage(message.id);
    if (!opts.skipDownstream) {
      if (result.text.trim().length > 0) {
        await runTranslationThenModeration({
          messageId: message.id,
          transcriptionId: pending.id,
          deps,
        });
      } else {
        // Silent recording: there is nothing to moderate, but we still want
        // the message in the operator queue rather than stuck in "received".
        // Scoped to `received` like `advanceMessageAfterModeration`, so that
        // re-transcribing an already-decided message cannot reopen it.
        await db.message.updateMany({
          where: { id: message.id, status: "received" },
          data: { status: "pending" },
        });
        await broadcastMessage(message.id);
      }
    }
    return { outcome: "created", transcriptionId: pending.id };
  } catch (error) {
    const reason = sanitizeError(error);
    const finalized = await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Message" WHERE "id" = ${message.id}::uuid FOR UPDATE
      `;
      return tx.transcription.updateMany({
        where: { id: pending.id, status: "pending", provider: provider.name },
        data: {
          status: "failed",
          error: reason,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
    });
    if (finalized.count === 0) return { outcome: "created", transcriptionId: pending.id };
    log("error", "ai.transcription.failed", {
      messageId: message.id,
      provider: provider.name,
      reason,
    });
    await broadcastMessage(message.id);
    return { outcome: "created", transcriptionId: pending.id };
  }
};

export interface RunTranslationOptions {
  readonly messageId: string;
  readonly transcriptionId: string;
  readonly deps?: PipelineDeps;
}

export type TranslationOutcome =
  | { outcome: "skipped"; reason: "english" | "empty_text" | "not_found" }
  | { outcome: "succeeded" }
  | { outcome: "failed"; reason: string }
  | { outcome: "deferred"; reason: "pending_push" };

// Runs a translation against the given transcription's text. Returns
// "deferred" when no in-process translation provider is configured but the
// transcription is non-English — in that case the row is marked
// `translationStatus = pending` so the pull worker can lease it. Returns
// "skipped" when translation is not needed (English) or impossible (no text).
export const runTranslation = async (opts: RunTranslationOptions): Promise<TranslationOutcome> => {
  const deps = opts.deps ?? buildDefaultPipelineDeps();
  const transcription = await db.transcription.findUnique({
    where: { id: opts.transcriptionId },
  });
  if (!transcription) return { outcome: "skipped", reason: "not_found" };
  const text = transcription.text?.trim() ?? "";
  if (text.length === 0) return { outcome: "skipped", reason: "empty_text" };
  if (isEnglishLanguage(transcription.language)) {
    return { outcome: "skipped", reason: "english" };
  }
  // Never overwrite an already-finalized translation. If the push worker (or
  // an earlier in-process run) already wrote `succeeded`, return as-is so
  // a sweeper / retry / parallel run can't downgrade the row back to
  // `pending` and clobber the worker's translatedText / model fields.
  if (transcription.translationStatus === "succeeded") {
    return { outcome: "succeeded" };
  }
  // Likewise, don't trample a translation the push worker is already handling
  // (status = pending). The worker will POST the result back to
  // `/v1/worker/messages/:id/translation`, which flips the row to `succeeded`.
  if (transcription.translationStatus === "pending") {
    return { outcome: "deferred", reason: "pending_push" };
  }

  const provider = deps.translationProvider;
  if (!provider) {
    if (deps.config.translationProvider !== "push") {
      await db.transcription.updateMany({
        where: {
          id: transcription.id,
          OR: [{ translationStatus: null }, { translationStatus: "failed" }],
        },
        data: {
          translationStatus: "failed",
          translationProvider: deps.config.translationProvider,
          translationError: "translation provider disabled",
          translationCompletedAt: new Date(),
        },
      });
      await broadcastMessage(opts.messageId);
      return { outcome: "failed", reason: "translation provider disabled" };
    }
    // Push mode — defer to the worker. Mark the row `pending` and broadcast a
    // `work` event so a subscribed app translates it and POSTs the result to
    // `/v1/worker/messages/:id/translation`. Use updateMany so we never flip a
    // row that a worker has just finalized between the read above and this
    // write.
    const claimed = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return 0;
      const latest = await tx.transcription.findFirst({
        where: { messageId: opts.messageId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!latest || latest.id !== transcription.id) return 0;
      const result = await tx.transcription.updateMany({
        where: {
          id: transcription.id,
          OR: [{ translationStatus: null }, { translationStatus: "failed" }],
        },
        data: {
          translationStatus: "pending",
          translationProvider: deps.config.translationProvider,
        },
      });
      return result.count;
    });
    if (claimed === 0) return { outcome: "deferred", reason: "pending_push" };
    await broadcastMessage(opts.messageId);
    broadcastWork(opts.messageId, ["translation"]);
    return { outcome: "deferred", reason: "pending_push" };
  }

  // Atomic claim: only proceed if the row is still null/failed. If a worker
  // raced in and set `pending` (or even `succeeded`) we bail out cleanly.
  const claimed = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return 0;
    const latest = await tx.transcription.findFirst({
      where: { messageId: opts.messageId, status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    if (!latest || latest.id !== transcription.id) return 0;
    const result = await tx.transcription.updateMany({
      where: {
        id: transcription.id,
        OR: [{ translationStatus: null }, { translationStatus: "failed" }],
      },
      data: {
        translationStatus: "pending",
        translationProvider: provider.name,
        translationModel: provider.model,
      },
    });
    return result.count;
  });
  if (claimed === 0) {
    // Someone else (worker or a concurrent in-process run) owns the row.
    return { outcome: "deferred", reason: "pending_push" };
  }
  await broadcastMessage(opts.messageId);

  const startedAt = Date.now();
  try {
    const result = await provider.translate({
      text,
      sourceLanguage: transcription.language,
    });
    const translatedText = normalizeTranslationText(result.text);
    // Only write the result if we still own the row (status === pending and
    // provider === ours). A pull-worker /succeed posted in the meantime
    // would have flipped status to `succeeded`; we leave that result alone.
    const finalized = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return 0;
      const current = await tx.transcription.findUnique({ where: { id: transcription.id } });
      const latest = await tx.transcription.findFirst({
        where: { messageId: opts.messageId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!current || !latest || latest.id !== current.id) return 0;
      const previousReviewText =
        current.translationStatus === "succeeded" &&
        typeof current.translatedText === "string" &&
        current.translatedText.trim().length > 0
          ? normalizeTranslationText(current.translatedText)
          : current.text?.trim();
      const updated = await tx.transcription.updateMany({
        where: {
          id: current.id,
          translationStatus: "pending",
          translationProvider: provider.name,
        },
        data: {
          translationStatus: "succeeded",
          translatedText,
          translatedLanguage: result.language,
          translationLatencyMs: Date.now() - startedAt,
          translationCompletedAt: new Date(),
          translationError: null,
        },
      });
      if (updated.count > 0 && previousReviewText !== translatedText) {
        await tx.moderation.updateMany({
          where: {
            messageId: opts.messageId,
            OR: [{ transcriptionId: current.id }, { transcriptionId: null }],
            status: { in: ["pending", "succeeded"] },
          },
          data: {
            status: "failed",
            error: "superseded_by_translation",
            completedAt: new Date(),
          },
        });
      }
      return updated.count;
    });
    if (finalized === 0) return { outcome: "deferred", reason: "pending_push" };
    log("info", "ai.translation.completed", {
      messageId: opts.messageId,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
    });
    await broadcastMessage(opts.messageId);
    return { outcome: "succeeded" };
  } catch (error) {
    const reason = sanitizeError(error);
    await db.transcription.updateMany({
      where: {
        id: transcription.id,
        translationStatus: "pending",
        translationProvider: provider.name,
      },
      data: {
        translationStatus: "failed",
        translationError: reason,
        translationLatencyMs: Date.now() - startedAt,
        translationCompletedAt: new Date(),
      },
    });
    log("error", "ai.translation.failed", {
      messageId: opts.messageId,
      provider: provider.name,
      reason,
    });
    await broadcastMessage(opts.messageId);
    return { outcome: "failed", reason };
  }
};

// Helper: run translation (if applicable) then moderation. Used by the
// in-process pipeline after a successful transcription. Moderation runs
// against the translated text if available, otherwise the original transcript.
export const runTranslationThenModeration = async (opts: {
  messageId: string;
  transcriptionId: string;
  deps?: PipelineDeps;
}): Promise<void> => {
  const deps = opts.deps ?? buildDefaultPipelineDeps();
  const translation = await runTranslation({
    messageId: opts.messageId,
    transcriptionId: opts.transcriptionId,
    deps,
  });
  if (translation.outcome === "deferred") return;
  // Proceed to moderation for all non-deferred outcomes:
  //   - succeeded → moderation runs against translated text.
  //   - skipped (English / not_found / empty) → moderation runs against
  //     the original transcript.
  //   - deferred (push worker will translate later) → stop here; the
  //     translation callback triggers moderation after translated text lands.
  //   - failed → moderation runs against original text; the failure is
  //     surfaced on the transcription row for human review.
  await runModeration({
    messageId: opts.messageId,
    transcriptionId: opts.transcriptionId,
    deps,
    requestedByUserId: null,
  });
};

export interface RecordTranscriptionResultOptions {
  readonly messageId: string;
  readonly transcriptionId?: string | null;
  readonly expectedLatestTranscriptionId?: string | null;
  readonly expectedLatestTranscriptionSha256?: string | null;
  readonly text: string;
  readonly language?: string | null;
  readonly model?: string | null;
  readonly provider?: "push" | "on_device";
  readonly processDownstream?: boolean;
  // Operator whose client produced the transcript (e.g. on-device iOS
  // transcription). Null for the worker push-back callback, which is not tied
  // to a human user.
  readonly requestedByUserId?: string | null;
}

export type RecordTranscriptionResultOutcome =
  | { outcome: "not_found" }
  | { outcome: "stale_transcription" }
  | { outcome: "unchanged"; transcriptionId: string }
  | { outcome: "recorded"; transcriptionId: string };

// Record a transcript produced outside the in-process pipeline. Shared by the
// worker push-back callback (`POST /v1/worker/messages/:id/transcription`) and
// the operator submit route (`POST /v1/messages/:id/transcription`).
//
// Transcriptions are unsolicited by design: the message is already `pending` in
// the operator queue and the client decides on its own when (or whether) to
// transcribe. When a pending row exists it is finalized; otherwise a new
// succeeded row is recorded rather than dropping the text on the floor. Retries
// must not duplicate history, so an identical redelivery of the latest
// succeeded transcript is treated as the no-op it is. Callers can suppress
// downstream processing when they are submitting their own complete result set.
export const recordTranscriptionResult = async (
  opts: RecordTranscriptionResultOptions,
): Promise<RecordTranscriptionResultOutcome> => {
  const recorded = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return { outcome: "not_found" } as const;
    const message = await tx.message.findUnique({
      where: { id: opts.messageId },
      select: { id: true, audio: { select: { durationMs: true } } },
    });
    if (!message) return { outcome: "not_found" } as const;

    if ("expectedLatestTranscriptionId" in opts || "expectedLatestTranscriptionSha256" in opts) {
      const latest = await tx.transcription.findFirst({
        where: { messageId: opts.messageId },
        orderBy: { createdAt: "desc" },
      });
      const latestSha256 = latest
        ? createHash("sha256")
            .update(`${latest.status}\n${latest.text?.trim() ?? ""}`, "utf8")
            .digest("hex")
        : null;
      if (
        ("expectedLatestTranscriptionId" in opts &&
          (latest?.id ?? null) !== (opts.expectedLatestTranscriptionId ?? null)) ||
        ("expectedLatestTranscriptionSha256" in opts &&
          latestSha256 !== (opts.expectedLatestTranscriptionSha256?.toLowerCase() ?? null))
      ) {
        return { outcome: "stale_transcription" } as const;
      }
    }
    const pending = await tx.transcription.findFirst({
      where: {
        messageId: opts.messageId,
        status: "pending",
        ...(opts.transcriptionId ? { id: opts.transcriptionId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      (opts.transcriptionId && !pending) ||
      (!opts.transcriptionId && pending && opts.provider !== "on_device")
    ) {
      return { outcome: "stale_transcription" } as const;
    }
    const now = new Date();
    if (pending) {
      const startedAt = pending.createdAt;
      const updated = await tx.transcription.updateMany({
        where: { id: pending.id, status: "pending" },
        data: {
          status: "succeeded",
          text: opts.text,
          language: opts.language ?? null,
          model: opts.model ?? (opts.provider == null ? pending.model : null),
          ...(opts.provider != null ? { provider: opts.provider } : {}),
          latencyMs: now.getTime() - startedAt.getTime(),
          completedAt: now,
          ...(opts.requestedByUserId != null ? { requestedById: opts.requestedByUserId } : {}),
        },
      });
      if (updated.count === 0) {
        return { outcome: "unchanged", transcriptionId: pending.id } as const;
      }
      await tx.moderation.updateMany({
        where: {
          messageId: opts.messageId,
          status: { in: ["pending", "succeeded"] },
        },
        data: {
          status: "failed",
          error: "superseded_by_transcription",
          completedAt: now,
        },
      });
      return { outcome: "recorded", transcriptionId: pending.id } as const;
    }

    const latest = await tx.transcription.findFirst({
      where: { messageId: opts.messageId },
      orderBy: { createdAt: "desc" },
    });
    if (
      !opts.transcriptionId &&
      opts.provider !== "on_device" &&
      latest?.status === "succeeded" &&
      latest.provider === "on_device"
    ) {
      return { outcome: "stale_transcription" } as const;
    }
    if (
      latest &&
      latest.status === "succeeded" &&
      (latest.text ?? "").trim() === opts.text.trim() &&
      (latest.language ?? null) === (opts.language ?? null) &&
      (latest.model ?? null) === (opts.model ?? null) &&
      latest.provider === (opts.provider ?? "push") &&
      (latest.requestedById ?? null) === (opts.requestedByUserId ?? null)
    ) {
      return { outcome: "unchanged", transcriptionId: latest.id } as const;
    }
    const created = await tx.transcription.create({
      data: {
        messageId: opts.messageId,
        provider: opts.provider ?? "push",
        model: opts.model ?? null,
        status: "succeeded",
        text: opts.text,
        language: opts.language ?? null,
        durationMs: message.audio?.durationMs ?? null,
        completedAt: now,
        requestedById: opts.requestedByUserId ?? null,
      },
    });
    await tx.moderation.updateMany({
      where: {
        messageId: opts.messageId,
        status: { in: ["pending", "succeeded"] },
      },
      data: {
        status: "failed",
        error: "superseded_by_transcription",
        completedAt: now,
      },
    });
    return { outcome: "recorded", transcriptionId: created.id } as const;
  });
  if (recorded.outcome !== "recorded") return recorded;
  const transcriptionId = recorded.transcriptionId;

  await broadcastMessage(opts.messageId);

  const hasText = opts.text.trim().length > 0;
  if (!hasText) {
    // Silent recording: nothing to translate or moderate. Legacy `received`
    // messages still need surfacing; anything newer is already `pending`.
    await advanceMessageAfterModeration(opts.messageId);
    await broadcastMessage(opts.messageId);
    return { outcome: "recorded", transcriptionId };
  }

  if (opts.processDownstream === false) {
    return { outcome: "recorded", transcriptionId };
  }

  await runTranslationThenModeration({
    messageId: opts.messageId,
    transcriptionId,
  });
  return { outcome: "recorded", transcriptionId };
};

export interface RecordTranslationResultOptions {
  readonly messageId: string;
  readonly transcriptionId?: string;
  readonly expectedTranscriptionId?: string;
  readonly expectedTranslationSha256?: string | null;
  readonly translatedText: string;
  readonly translatedLanguage?: string | null;
  readonly model?: string | null;
  // Targeted results came from an operator's device. Untargeted submissions
  // are a human correction and intentionally retain null provenance.
  readonly provider?: "on_device";
}

export type RecordTranslationResultOutcome =
  | { outcome: "not_found" }
  | { outcome: "no_transcription" }
  | { outcome: "stale_transcription" }
  | { outcome: "stale_translation" }
  | { outcome: "recorded"; transcriptionId: string };

// Shared stale-safe translation write used by the web correction route and
// the leased on-device processing surface. Keeping it here prevents a new
// client contract from weakening the snapshot protection of the older route.
export const recordTranslationResult = async (
  opts: RecordTranslationResultOptions,
): Promise<RecordTranslationResultOutcome> => {
  const translatedText = normalizeTranslationText(opts.translatedText);
  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return { outcome: "not_found" } as const;
    const latest = await tx.transcription.findFirst({
      where: { messageId: opts.messageId, status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    if (!latest) return { outcome: "no_transcription" } as const;
    const targetId = opts.transcriptionId ?? opts.expectedTranscriptionId;
    if (targetId && latest.id !== targetId) return { outcome: "stale_transcription" } as const;

    if (opts.expectedTranslationSha256 !== undefined) {
      const currentTranslation =
        latest.translationStatus === "succeeded" &&
        typeof latest.translatedText === "string" &&
        latest.translatedText.trim().length > 0
          ? normalizeTranslationText(latest.translatedText)
          : null;
      const currentTranslationSha256 =
        currentTranslation === null
          ? null
          : createHash("sha256").update(currentTranslation, "utf8").digest("hex");
      if (currentTranslationSha256 !== opts.expectedTranslationSha256) {
        return { outcome: "stale_translation" } as const;
      }
    }

    const previousReviewText =
      latest.translationStatus === "succeeded" &&
      typeof latest.translatedText === "string" &&
      latest.translatedText.trim().length > 0
        ? normalizeTranslationText(latest.translatedText)
        : latest.text?.trim();
    if (previousReviewText !== translatedText) {
      await tx.moderation.updateMany({
        where: {
          messageId: opts.messageId,
          OR: [{ transcriptionId: latest.id }, { transcriptionId: null }],
          status: { in: ["pending", "succeeded"] },
        },
        data: {
          status: "failed",
          error: "superseded_by_translation",
          completedAt: new Date(),
        },
      });
    }
    const transcription = await tx.transcription.update({
      where: { id: latest.id },
      data: {
        translationStatus: "succeeded",
        translatedText,
        translatedLanguage: opts.translatedLanguage ?? null,
        translationProvider: opts.provider ?? null,
        translationModel: opts.provider ? (opts.model ?? null) : null,
        translationError: null,
        translationCompletedAt: new Date(),
      },
    });
    return { outcome: "recorded", transcriptionId: transcription.id } as const;
  });
  if (result.outcome !== "recorded") return result;
  await broadcastMessage(opts.messageId);
  return result;
};

export interface RecordModerationResultOptions {
  readonly messageId: string;
  readonly transcriptionId?: string | null;
  readonly flagged: boolean;
  readonly recommendation: ModerationRecommendation;
  readonly maxScore: number;
  readonly categories?: Record<string, number> | null;
  readonly reasonSummary?: string | null;
  readonly model?: string | null;
  readonly inputSha256?: string | null;
  // Provider label to stamp on the row. The worker callback leaves the
  // solicited row's own provider in place; the operator submit route records
  // "on_device" so the UI can tell a locally computed verdict from an
  // upstream one.
  readonly provider?: string;
  readonly requestedByUserId?: string | null;
  // What to do when there is no pending row to finalize. Worker callbacks are
  // solicited — `runModeration` always creates the pending row first — so a
  // callback without one is stale and is dropped. An operator device
  // volunteering a verdict out of band has no pending row by definition, so it
  // records a new succeeded one instead.
  readonly createWhenMissing: boolean;
}

export type RecordModerationResultOutcome =
  | { outcome: "not_found" }
  | { outcome: "transcription_not_found" }
  | { outcome: "stale_transcription" }
  | { outcome: "stale_input" }
  | { outcome: "unchanged"; moderationId: string | null }
  | { outcome: "recorded"; moderationId: string };

// Compare a stored `categories` JSON blob with a submitted map, independent of
// key order. Used only for the redelivery check: a corrected category score is
// a new verdict, not a duplicate.
const categoriesMatch = (
  stored: unknown,
  submitted: Record<string, number> | null | undefined,
): boolean => {
  const next = submitted ?? {};
  const previous =
    stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== Object.keys(previous).length) return false;
  return nextKeys.every((key) => previous[key] === next[key]);
};

// Record a moderation verdict produced outside the in-process pipeline. Shared
// by the worker push-back callback (`POST /v1/worker/messages/:id/moderation`)
// and the operator submit route (`POST /v1/messages/:id/moderation`).
//
// The verdict is always ADVISORY: it surfaces the message for review
// (`received` → `pending`) but never decides it. Only
// `POST /v1/messages/:id/decision` does that.
export const recordModerationResult = async (
  opts: RecordModerationResultOptions,
): Promise<RecordModerationResultOutcome> => {
  const recorded = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return { outcome: "not_found" } as const;

    if (opts.transcriptionId) {
      const transcription = await tx.transcription.findUnique({
        where: { id: opts.transcriptionId },
      });
      if (!transcription || transcription.messageId !== opts.messageId) {
        return { outcome: "transcription_not_found" } as const;
      }
      const latest = await tx.transcription.findFirst({
        where: { messageId: opts.messageId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!latest || latest.id !== opts.transcriptionId) {
        return { outcome: "stale_transcription" } as const;
      }
      if (opts.inputSha256) {
        const input =
          transcription.translationStatus === "succeeded" &&
          typeof transcription.translatedText === "string" &&
          transcription.translatedText.trim().length > 0
            ? normalizeTranslationText(transcription.translatedText)
            : (transcription.text ?? "").trim();
        const actualHash = createHash("sha256").update(input.trim(), "utf8").digest("hex");
        if (actualHash !== opts.inputSha256) return { outcome: "stale_input" } as const;
      }
    }

    const pending = await tx.moderation.findFirst({
      where: {
        messageId: opts.messageId,
        ...(opts.transcriptionId ? { transcriptionId: opts.transcriptionId } : {}),
        status: "pending",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!opts.transcriptionId && pending?.transcriptionId) {
      return { outcome: "stale_transcription" } as const;
    }
    const now = new Date();
    const provider = opts.provider ?? null;
    let moderationId: string | null = null;
    if (pending) {
      const startedAt = pending.createdAt;
      const updated = await tx.moderation.updateMany({
        where: { id: pending.id, status: "pending" },
        data: {
          status: "succeeded",
          flagged: opts.flagged,
          recommendation: opts.recommendation,
          maxScore: opts.maxScore,
          categories: opts.categories ?? {},
          reasonSummary: opts.reasonSummary ?? null,
          model: opts.model ?? (provider === null ? pending.model : null),
          ...(provider !== null ? { provider } : {}),
          latencyMs: now.getTime() - startedAt.getTime(),
          completedAt: now,
          ...(opts.requestedByUserId != null ? { requestedById: opts.requestedByUserId } : {}),
        },
      });
      if (updated.count > 0) moderationId = pending.id;
      else if (!opts.createWhenMissing) {
        return { outcome: "unchanged", moderationId: pending.id } as const;
      }
    }

    if (moderationId === null) {
      if (!opts.createWhenMissing) {
        return { outcome: "unchanged", moderationId: null } as const;
      }
      const latest = await tx.moderation.findFirst({
        where: { messageId: opts.messageId },
        orderBy: { createdAt: "desc" },
      });
      if (
        latest &&
        latest.status === "succeeded" &&
        (latest.transcriptionId ?? null) === (opts.transcriptionId ?? null) &&
        latest.provider === (provider ?? "push") &&
        latest.flagged === opts.flagged &&
        latest.recommendation === opts.recommendation &&
        latest.maxScore === opts.maxScore &&
        categoriesMatch(latest.categories, opts.categories) &&
        (latest.reasonSummary ?? null) === (opts.reasonSummary ?? null) &&
        (latest.model ?? null) === (opts.model ?? null) &&
        (latest.requestedById ?? null) === (opts.requestedByUserId ?? null)
      ) {
        return { outcome: "unchanged", moderationId: latest.id } as const;
      }
      const created = await tx.moderation.create({
        data: {
          messageId: opts.messageId,
          transcriptionId: opts.transcriptionId ?? null,
          provider: provider ?? "push",
          model: opts.model ?? null,
          status: "succeeded",
          flagged: opts.flagged,
          recommendation: opts.recommendation,
          maxScore: opts.maxScore,
          categories: opts.categories ?? {},
          reasonSummary: opts.reasonSummary ?? null,
          completedAt: now,
          requestedById: opts.requestedByUserId ?? null,
        },
      });
      moderationId = created.id;
    }
    return { outcome: "recorded", moderationId } as const;
  });
  if (recorded.outcome !== "recorded") return recorded;

  await advanceMessageAfterModeration(opts.messageId);
  await broadcastMessage(opts.messageId);
  return recorded;
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
    if (deps.config.moderationProvider === "push") {
      const pending = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
        `;
        if (rows.length === 0) return null;
        const current = await tx.transcription.findFirst({
          where: { messageId: opts.messageId, status: "succeeded" },
          orderBy: { createdAt: "desc" },
        });
        if (!current || current.id !== transcription.id) return null;
        const existing = await tx.moderation.findFirst({
          where: {
            messageId: opts.messageId,
            transcriptionId: current.id,
            status: "pending",
            provider: "push",
          },
          orderBy: { createdAt: "desc" },
        });
        return (
          existing ??
          (await tx.moderation.create({
            data: {
              messageId: opts.messageId,
              transcriptionId: current.id,
              provider: "push",
              model: null,
              status: "pending",
              requestedById: opts.requestedByUserId,
            },
          }))
        );
      });
      if (!pending) return null;
      await broadcastMessage(opts.messageId);
      broadcastWork(opts.messageId, ["moderation"]);
      return pending.id;
    }
    const failed = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return null;
      const current = await tx.transcription.findFirst({
        where: { messageId: opts.messageId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!current || current.id !== transcription.id) return null;
      const result = await tx.moderation.create({
        data: {
          messageId: opts.messageId,
          transcriptionId: current.id,
          provider: deps.config.moderationProvider,
          model: null,
          status: "failed",
          error: "moderation provider disabled",
          requestedById: opts.requestedByUserId,
          completedAt: new Date(),
        },
      });
      await tx.message.updateMany({
        where: { id: opts.messageId, status: "received" },
        data: { status: "pending" },
      });
      return result;
    });
    if (!failed) return null;
    await broadcastMessage(opts.messageId);
    return failed.id;
  }

  const prepared = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return null;
    const current = await tx.transcription.findFirst({
      where: { messageId: opts.messageId, status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    if (!current || current.id !== transcription.id) return null;
    const translatedText =
      current.translationStatus === "succeeded" &&
      typeof current.translatedText === "string" &&
      current.translatedText.trim().length > 0
        ? normalizeTranslationText(current.translatedText)
        : null;
    const text =
      translatedText !== null && translatedText.length > 0
        ? translatedText
        : (current.text ?? "").trim();
    if (text.length === 0) return null;
    const pending = await tx.moderation.create({
      data: {
        messageId: opts.messageId,
        transcriptionId: current.id,
        provider: provider.name,
        model: provider.model,
        status: "pending",
        requestedById: opts.requestedByUserId,
      },
    });
    return { pending, text };
  });
  if (!prepared) return null;
  const { pending, text: moderationText } = prepared;
  await broadcastMessage(opts.messageId);

  const startedAt = Date.now();
  try {
    const result = await provider.moderate({ text: moderationText });
    const finalized = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return { count: 0 };
      const latest = await tx.transcription.findFirst({
        where: { messageId: opts.messageId, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!latest || latest.id !== pending.transcriptionId) return { count: 0 };
      return tx.moderation.updateMany({
        where: { id: pending.id, status: "pending", provider: provider.name },
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
    });
    if (finalized.count === 0) return pending.id;
    log("info", "ai.moderation.completed", {
      messageId: opts.messageId,
      provider: provider.name,
      recommendation: result.recommendation,
      maxScore: result.maxScore,
      latencyMs: Date.now() - startedAt,
    });
    await advanceMessageAfterModeration(opts.messageId);
    await broadcastMessage(opts.messageId);
    return pending.id;
  } catch (error) {
    const reason = sanitizeError(error);
    const finalized = await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Message" WHERE "id" = ${opts.messageId}::uuid FOR UPDATE
      `;
      return tx.moderation.updateMany({
        where: { id: pending.id, status: "pending", provider: provider.name },
        data: {
          status: "failed",
          error: reason,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      });
    });
    if (finalized.count === 0) return pending.id;
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
//
// Transcription is optional enrichment, not a gate: a completed message is
// already `pending` in the operator queue. In `push` mode the external
// Transcription app decides when to transcribe and POSTs the result to
// `/v1/worker/messages/:id/transcription`, so the API never solicits the work;
// in `disabled` mode there is nothing to run at all. Both are skipped here so
// we don't litter messages with unsolicited pending / failed transcription
// rows. Operators can still request one explicitly via
// `POST /v1/messages/:id/transcribe`.
export const kickPipelineForMessage = (messageId: string): void => {
  const provider = resolveAiConfig().transcriptionProvider;
  if (provider === "push" || provider === "disabled") return;
  setImmediate(() => {
    void runTranscription({ messageId }).catch((error: unknown) => {
      const reason = sanitizeError(error);
      log("error", "ai.pipeline.unhandled", { messageId, reason });
    });
  });
};
