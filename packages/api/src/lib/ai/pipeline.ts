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

import { generateSasUrl } from "../azure-blob.js";
import { broadcastWork, wsBroadcaster } from "../broadcaster.js";
import { db } from "../db.js";
import { serializeMessage } from "../serializers.js";
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

  if (!provider) {
    // Push mode: no in-process transcription provider, but a subscribed
    // Transcription app will do the work. Create the pending row and broadcast
    // a `work` event so the app fetches the audio and posts the text back to
    // /v1/worker/messages/:id/transcription. (In a truly disabled config we
    // instead record a failed row below.)
    if (deps.config.transcriptionProvider === "push") {
      const existing = await db.transcription.findFirst({
        where: { messageId: message.id, status: "pending" },
        orderBy: { createdAt: "desc" },
      });
      const pending =
        existing ??
        (await db.transcription.create({
          data: {
            messageId: message.id,
            provider: "push",
            model: null,
            status: "pending",
            durationMs: message.audio.durationMs,
            requestedById: opts.requestedByUserId ?? null,
          },
        }));
      await broadcastMessage(message.id);
      broadcastWork(message.id, ["transcription"]);
      return { outcome: "created", transcriptionId: pending.id };
    }
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
    await db.transcription.updateMany({
      where: {
        id: transcription.id,
        OR: [{ translationStatus: null }, { translationStatus: "failed" }],
      },
      data: {
        translationStatus: "pending",
        translationProvider: deps.config.translationProvider,
      },
    });
    await broadcastMessage(opts.messageId);
    broadcastWork(opts.messageId, ["translation"]);
    return { outcome: "deferred", reason: "pending_push" };
  }

  // Atomic claim: only proceed if the row is still null/failed. If a worker
  // raced in and set `pending` (or even `succeeded`) we bail out cleanly.
  const claimed = await db.transcription.updateMany({
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
  if (claimed.count === 0) {
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
    // Only write the result if we still own the row (status === pending and
    // provider === ours). A pull-worker /succeed posted in the meantime
    // would have flipped status to `succeeded`; we leave that result alone.
    await db.transcription.updateMany({
      where: {
        id: transcription.id,
        translationStatus: "pending",
        translationProvider: provider.name,
      },
      data: {
        translationStatus: "succeeded",
        translatedText: result.text,
        translatedLanguage: result.language,
        translationLatencyMs: Date.now() - startedAt,
        translationCompletedAt: new Date(),
        translationError: null,
      },
    });
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
  readonly text: string;
  readonly language?: string | null;
  readonly model?: string | null;
  // Operator whose client produced the transcript (e.g. on-device iOS
  // transcription). Null for the worker push-back callback, which is not tied
  // to a human user.
  readonly requestedByUserId?: string | null;
}

export type RecordTranscriptionResultOutcome =
  | { outcome: "not_found" }
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
// succeeded transcript is treated as the no-op it is. Client-generated text is
// still translated and moderated server-side before it can be acted on.
export const recordTranscriptionResult = async (
  opts: RecordTranscriptionResultOptions,
): Promise<RecordTranscriptionResultOutcome> => {
  const message = await db.message.findUnique({
    where: { id: opts.messageId },
    select: { id: true, audio: { select: { durationMs: true } } },
  });
  if (!message) return { outcome: "not_found" };

  const pending = await db.transcription.findFirst({
    where: { messageId: opts.messageId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  let transcriptionId: string;
  if (pending) {
    const startedAt = pending.createdAt;
    const updated = await db.transcription.updateMany({
      where: { id: pending.id, status: "pending" },
      data: {
        status: "succeeded",
        text: opts.text,
        language: opts.language ?? null,
        model: opts.model ?? pending.model,
        latencyMs: now.getTime() - startedAt.getTime(),
        completedAt: now,
        // Attribute the finalized row to the submitting operator when known,
        // without clobbering an existing attribution for the worker callback.
        ...(opts.requestedByUserId != null ? { requestedById: opts.requestedByUserId } : {}),
      },
    });
    if (updated.count === 0) return { outcome: "unchanged", transcriptionId: pending.id };
    transcriptionId = pending.id;
  } else {
    const latest = await db.transcription.findFirst({
      where: { messageId: opts.messageId },
      orderBy: { createdAt: "desc" },
    });
    // A retry resends the exact same payload from the same caller, so the
    // no-op check compares the whole submission — not just the text. Language
    // in particular decides whether translation runs, so a resubmission that
    // only corrects it must record a new attempt rather than be swallowed.
    if (
      latest &&
      latest.status === "succeeded" &&
      (latest.text ?? "").trim() === opts.text.trim() &&
      (latest.language ?? null) === (opts.language ?? null) &&
      (latest.model ?? null) === (opts.model ?? null) &&
      (latest.requestedById ?? null) === (opts.requestedByUserId ?? null)
    ) {
      return { outcome: "unchanged", transcriptionId: latest.id };
    }
    // The client owns the latency here, so we do not invent one.
    const created = await db.transcription.create({
      data: {
        messageId: opts.messageId,
        provider: "push",
        model: opts.model ?? null,
        status: "succeeded",
        text: opts.text,
        language: opts.language ?? null,
        durationMs: message.audio?.durationMs ?? null,
        completedAt: now,
        requestedById: opts.requestedByUserId ?? null,
      },
    });
    transcriptionId = created.id;
  }

  await broadcastMessage(opts.messageId);

  const hasText = opts.text.trim().length > 0;
  if (!hasText) {
    // Silent recording: nothing to translate or moderate. Legacy `received`
    // messages still need surfacing; anything newer is already `pending`.
    await advanceMessageAfterModeration(opts.messageId);
    await broadcastMessage(opts.messageId);
    return { outcome: "recorded", transcriptionId };
  }

  await runTranslationThenModeration({
    messageId: opts.messageId,
    transcriptionId,
  });
  return { outcome: "recorded", transcriptionId };
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
      const existing = await db.moderation.findFirst({
        where: {
          messageId: opts.messageId,
          transcriptionId: transcription.id,
          status: "pending",
          provider: "push",
        },
        orderBy: { createdAt: "desc" },
      });
      const pending =
        existing ??
        (await db.moderation.create({
          data: {
            messageId: opts.messageId,
            transcriptionId: transcription.id,
            provider: "push",
            model: null,
            status: "pending",
            requestedById: opts.requestedByUserId,
          },
        }));
      await broadcastMessage(opts.messageId);
      broadcastWork(opts.messageId, ["moderation"]);
      return pending.id;
    }
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
  // Prefer translated text when present so moderation works on English even
  // for non-English audio inputs. Falls back to the raw transcript otherwise.
  const moderationText =
    transcription.translationStatus === "succeeded" &&
    typeof transcription.translatedText === "string" &&
    transcription.translatedText.trim().length > 0
      ? transcription.translatedText
      : transcription.text;
  try {
    const result = await provider.moderate({ text: moderationText });
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
    await advanceMessageAfterModeration(opts.messageId);
    await broadcastMessage(opts.messageId);
    return pending.id;
  } catch (error) {
    const reason = sanitizeError(error);
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
