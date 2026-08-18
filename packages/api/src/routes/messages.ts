import { zValidator } from "@hono/zod-validator";
import { Prisma } from "../generated/prisma/client.js";
import {
  InstallationScopeSchema,
  MessageCreateSchema,
  MessageDecisionSchema,
  MessageStatusSchema,
  ModerationSubmitSchema,
  TranscriptionSubmitSchema,
  TranslationSubmitSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveAiConfig } from "../lib/ai/config.js";
import { recordAudit } from "../lib/audit.js";
import {
  advanceMessageAfterModeration,
  kickPipelineForMessage,
  recordModerationResult,
  recordTranscriptionResult,
  recordTranslationResult,
  runModeration,
  runTranscription,
} from "../lib/ai/pipeline.js";
import { fanOutNotification } from "../lib/apns.js";
import { generateSasUrl, headBlob } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import {
  lockInstallationForWrite,
  runWithOpenEra,
  requireActiveInstallation,
  resolveInstallationScope,
  scopeWhere,
} from "../lib/installation.js";
import { countMessagesAwaitingModeration } from "../lib/moderation-badge.js";
import { notifyMessageFlagged, observeModerationQueue } from "../lib/push-events.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import {
  serializeMessage,
  serializeModeration,
  serializeTranscription,
} from "../lib/serializers.js";
import type { AuthVariables } from "../lib/session.js";
import { normalizeTranslationText } from "../lib/translation-text.js";

const listQuerySchema = z.object({
  status: MessageStatusSchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  installationId: InstallationScopeSchema.optional(),
});

const idParamSchema = z.object({ id: z.guid() });

const messageBlobName = (sha256: string): string => `messages/${sha256.slice(0, 2)}/${sha256}.flac`;

/**
 * A question the booth may still record an answer for.
 *
 * `active` is the normal case. The exception is the rollover straggler: an
 * operator ends an era while a caller is midway through answering, the era's
 * live questions are archived with `retiredAt = endedAt`, and the recording
 * lands afterwards. Bouncing that with a 404 would throw away a real recording
 * over admin bookkeeping, which is precisely what this feature is meant to
 * tolerate, so a question retired *by a rollover* stays answerable. A question
 * an operator retired by hand does not: that is a deliberate withdrawal.
 *
 * The straggler's message is still attributed to the open era rather than the
 * closed one. The closed era's moderation queue was drained and its summary
 * frozen on the way out, so filing it there would leave it pending in a scope
 * nobody is watching -- visible-and-moderatable beats chronologically tidy.
 */
async function questionIsAnswerable(question: {
  status: string;
  retiredAt: Date | null;
  installationId: string | null;
}): Promise<boolean> {
  if (question.status === "active") return true;
  if (question.status !== "archived" || question.retiredAt === null) return false;
  if (question.installationId === null) return false;
  const era = await db.installation.findUnique({
    where: { id: question.installationId },
    select: { endedAt: true },
  });
  return era?.endedAt?.getTime() === question.retiredAt.getTime();
}

export const messagesRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

messagesRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { status, since, limit, installationId } = c.req.valid("query");
  const scope = await resolveInstallationScope(installationId);
  const messages = await db.message.findMany({
    where: {
      ...scopeWhere(scope),
      ...(status ? { status } : {}),
      ...(since ? { createdAt: { gte: new Date(since) } } : {}),
    },
    include: {
      audio: true,
      transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      moderations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return c.json({ items: messages.map((message) => serializeMessage(message as never)) });
});

messagesRouter.get("/random", requireApiToken(), async (c) => {
  const where = { status: "approved" } as const;
  const count = await db.message.count({ where });
  if (count === 0) return c.json({ error: "no_messages_available" }, 404);

  const skip = Math.floor(Math.random() * count);
  const message = await db.message.findFirst({
    where,
    include: { audio: true },
    orderBy: { id: "asc" },
    skip,
  });
  if (!message) return c.json({ error: "no_messages_available" }, 404);
  return c.json(serializeMessage(message as never));
});

messagesRouter.get("/:id", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const message = await db.message.findUnique({
    where: { id },
    include: {
      audio: true,
      transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      moderations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!message) return c.json({ error: "not_found" }, 404);
  return c.json(serializeMessage(message as never));
});

// An ended era's counters are frozen at close-out, so anything that would
// change what they counted — a moderation decision, a deletion — is refused
// once the era is closed. Transcribing or translating an old recording is
// still allowed: it adds text without contradicting a frozen number.
//
// The check has to hold for the length of the write, or a rollover committing
// between the two puts the change on the wrong side of the freeze. Holding the
// era row shared is what makes the two queue instead of overlapping.
export class InstallationEndedError extends Error {}

const withOpenEra = async <T>(
  installationId: string | null,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  db.$transaction(async (tx) => {
    if (installationId !== null && !(await lockInstallationForWrite(tx, installationId))) {
      throw new InstallationEndedError();
    }
    return write(tx);
  });

messagesRouter.delete("/:id", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  recordAudit(c, { action: "message.delete", targetType: "message", targetId: id });
  const existing = await db.message.findUnique({ where: { id } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  try {
    await withOpenEra(existing.installationId, (tx) => tx.message.delete({ where: { id } }));
  } catch (error) {
    if (error instanceof InstallationEndedError) {
      return c.json({ error: "installation_ended" }, 409);
    }
    throw error;
  }
  recordAudit(c, { metadata: { previousStatus: existing.status } });
  if (existing.status === "received" || existing.status === "pending") {
    void observeModerationQueue("message.delete");
  }
  return c.body(null, 204);
});

messagesRouter.post("/", requireApiToken(), zValidator("json", MessageCreateSchema), async (c) => {
  const body = c.req.valid("json");
  const blobName = messageBlobName(body.sha256);
  recordAudit(c, {
    action: "message.create",
    targetType: "message",
    metadata: { sha256: body.sha256, questionId: body.questionId ?? null },
  });
  const requestedQuestionId = body.questionId ?? null;
  const uploadSlot = (id: string) => {
    recordAudit(c, { targetId: id });
    const sas = generateSasUrl(blobName, { permissions: "cw", contentType: "audio/flac" });
    return c.json({ id, uploadUrl: sas.url, blobName }, 201);
  };
  const matchesReplayRequest = (message: { questionId: string | null; status: string }) =>
    message.status === "uploading" && message.questionId === requestedQuestionId;

  const existingFile = await db.file.findUnique({ where: { sha256: body.sha256 } });
  if (existingFile) {
    const existingMessage = await db.message.findUnique({ where: { audioId: existingFile.id } });
    if (existingMessage) {
      // Idempotent re-initiation: a message still in "uploading" never had its
      // blob land (e.g. the booth crashed or rebooted between create and the
      // Azure PUT). Hand back a fresh SAS + the existing id so the booth can
      // resume the upload instead of stranding the recording. Only a message
      // that has advanced past "uploading" is a genuine duplicate.
      if (matchesReplayRequest(existingMessage)) {
        return uploadSlot(existingMessage.id);
      }
      return c.json({ error: "message_already_exists" }, 409);
    }
  }

  if (body.questionId) {
    const question = await db.question.findUnique({ where: { id: body.questionId } });
    if (!question || !(await questionIsAnswerable(question)))
      return c.json({ error: "question_not_found" }, 404);
  }
  if (existingFile && existingFile.blobKey !== blobName) {
    return c.json({ error: "message_already_exists" }, 409);
  }

  const file = await db.file.upsert({
    where: { sha256: body.sha256 },
    create: {
      blobContainer: process.env.AZURE_BLOB_CONTAINER?.trim() || "booth-recordings",
      blobKey: blobName,
      sha256: body.sha256,
      sizeBytes: 0,
      durationMs: body.durationMs,
      contentType: "audio/flac",
    },
    update: {},
  });

  const existingMessage = await db.message.findUnique({ where: { audioId: file.id } });
  if (existingMessage) {
    if (matchesReplayRequest(existingMessage)) {
      return uploadSlot(existingMessage.id);
    }
    return c.json({ error: "message_already_exists" }, 409);
  }

  let message;
  try {
    message = await db.message.create({
      data: {
        status: "uploading",
        questionId: body.questionId ?? null,
        audioId: file.id,
        installationId: await requireActiveInstallation(),
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost a create race. The winner's row exists; if it is still
      // "uploading", re-issue a slot so this caller can proceed rather than
      // bouncing off a 409.
      const raced = await db.message.findUnique({ where: { audioId: file.id } });
      if (raced && matchesReplayRequest(raced)) {
        return uploadSlot(raced.id);
      }
      return c.json({ error: "message_already_exists" }, 409);
    }
    // A hard purge collects files its era owned that nothing else references,
    // and this content-addressed row can become one of them between the upsert
    // above and this insert — the purge saw no referrer because this message
    // did not exist yet. Re-create the file and try once more rather than
    // failing a booth recording over an admin's housekeeping.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      const replacement = await db.file.upsert({
        where: { sha256: body.sha256 },
        create: {
          blobContainer: process.env.AZURE_BLOB_CONTAINER?.trim() || "booth-recordings",
          blobKey: blobName,
          sha256: body.sha256,
          sizeBytes: 0,
          durationMs: body.durationMs,
          contentType: "audio/flac",
        },
        update: {},
      });
      message = await db.message.create({
        data: {
          status: "uploading",
          questionId: body.questionId ?? null,
          audioId: replacement.id,
          installationId: await requireActiveInstallation(),
        },
      });
      return uploadSlot(message.id);
    }
    throw err;
  }
  return uploadSlot(message.id);
});

messagesRouter.post(
  "/:id/complete",
  requireApiToken(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    recordAudit(c, { action: "message.complete", targetType: "message", targetId: id });
    const message = await db.message.findUnique({ where: { id }, include: { audio: true } });
    if (!message) return c.json({ error: "not_found" }, 404);

    const blob = await headBlob(message.audio.blobKey);
    if (!blob.exists) return c.json({ error: "blob_not_found" }, 409);
    if (!blob.sha256) return c.json({ error: "sha256_metadata_missing" }, 422);
    if (blob.sha256 !== message.audio.sha256) return c.json({ error: "sha256_mismatch" }, 422);

    const { maxAudioBytes } = resolveAiConfig();
    if (blob.sizeBytes > maxAudioBytes) {
      return c.json({ error: "audio_too_large", maxBytes: maxAudioBytes }, 413);
    }

    await db.file.update({
      where: { id: message.audio.id },
      data: {
        sizeBytes: blob.sizeBytes,
        contentType: blob.contentType ?? message.audio.contentType,
      },
    });

    // Idempotent transition: only move from "uploading" → "pending".
    // If the message already advanced past "uploading" (e.g. retry after
    // timeout), skip the pipeline and return the current state.
    //
    // A landed recording goes straight into the operator review queue.
    // Transcription is optional enrichment pushed in later by the external
    // Transcription app (see docs/transcription-providers.md), so it must
    // never gate whether an operator can see and decide a message.
    const receivedAt = new Date();
    // A recording that was in flight when the operator ended an era belongs in
    // the open one: that era's queue was drained and its summary frozen on the
    // way out, so leaving it there would file a real recording where nobody is
    // looking. The promotion holds the destination era row shared for its whole
    // transaction, so it cannot commit into an era whose close-out is underway
    // but not yet visible — the rollover waits for it, or it waits for the
    // rollover and re-files.
    // The recording's own era is only a hint: it may have ended while the
    // upload was in flight, in which case another is resolved — or opened —
    // outside the transaction and the promotion retried.
    // A retry of a completion that already landed must stay a no-op. Resolving
    // an era for it would open a blank one on the way to an update that
    // matches nothing, so the already-promoted case never gets that far.
    const alreadyLanded = message.status !== "uploading";
    const { count } = alreadyLanded
      ? { count: 0 }
      : await runWithOpenEra(message.installationId ?? undefined, async (tx, era) => {
          const refiled = era === message.installationId ? null : era;
          return tx.message.updateMany({
            where: { id, status: "uploading" },
            data: {
              status: "pending",
              receivedAt,
              ...(refiled ? { installationId: refiled } : {}),
            },
          });
        });

    if (count === 0) {
      const current = await db.message.findUnique({ where: { id } });
      return c.json({
        id: current!.id,
        status: current!.status,
        receivedAt: current!.receivedAt?.toISOString() ?? null,
      });
    }

    // Fire-and-forget. The pipeline catches its own errors and updates the
    // DB asynchronously; the booth's `/complete` call does not wait on AI.
    // In push/disabled transcription modes this is a no-op — the external app
    // decides when to transcribe and posts the result back.
    kickPipelineForMessage(id);
    // Push fan-out: notify mobile devices that a new message has landed.
    // The badge reflects the number of messages awaiting moderation (this
    // one is now "pending", so it is already included in the count).
    const badge = await countMessagesAwaitingModeration();
    void observeModerationQueue("message.complete");
    void fanOutNotification({
      kind: "alert",
      preferenceKey: "messageReceived",
      title: "New booth message",
      body: "A new recording is ready to moderate.",
      badge,
      threadId: `message:${id}`,
      category: "BOOTH_MESSAGE",
      data: { messageId: id },
    });
    return c.json({ id, status: "pending", receivedAt: receivedAt.toISOString() });
  },
);

messagesRouter.get("/:id/transcriptions", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const message = await db.message.findUnique({ where: { id }, select: { id: true } });
  if (!message) return c.json({ error: "not_found" }, 404);
  const items = await db.transcription.findMany({
    where: { messageId: id },
    orderBy: { createdAt: "desc" },
  });
  return c.json({ items: items.map(serializeTranscription) });
});

messagesRouter.post("/:id/transcribe", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  recordAudit(c, { action: "message.transcription.request", targetType: "message", targetId: id });
  const message = await db.message.findUnique({ where: { id }, select: { id: true } });
  if (!message) return c.json({ error: "not_found" }, 404);
  const user = c.get("user") as { id: string } | undefined;
  const transcriptionResult = await runTranscription({
    messageId: id,
    requestedByUserId: user?.id ?? null,
  });
  if (transcriptionResult.outcome === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (transcriptionResult.outcome === "skipped") {
    return c.json(
      { error: "transcription_already_pending", transcriptionId: transcriptionResult.existingId },
      409,
    );
  }
  const row = await db.transcription.findUnique({
    where: { id: transcriptionResult.transcriptionId },
  });
  if (!row) return c.json({ error: "not_found" }, 404);
  recordAudit(c, { metadata: { transcriptionId: row.id, provider: row.provider } });
  return c.json(serializeTranscription(row), 202);
});

// Operator-submitted transcript: a logged-in operator (e.g. the iOS Transcriber
// app doing on-device transcription) records transcript text directly, rather
// than triggering the server-side transcription pipeline via `/transcribe`.
// Mirrors the worker push-back semantics — finalizes a pending row or records a
// new succeeded one — but attributes the row to the submitting operator.
// Complete on-device pipelines suppress downstream provider work.
messagesRouter.post(
  "/:id/transcription",
  zValidator("param", idParamSchema),
  zValidator("json", TranscriptionSubmitSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const {
      expectedLatestTranscriptionId,
      expectedLatestTranscriptionSha256,
      text,
      language,
      model,
      processDownstream,
    } = data;
    // An operator overriding the machine transcript is exactly the kind of
    // edit the trail exists for; the text itself stays in the Transcription row.
    recordAudit(c, {
      action: "message.transcription.submit",
      targetType: "message",
      targetId: id,
      metadata: { model: model ?? null, language: language ?? null, textLength: text.length },
    });
    const user = c.get("user") as { id: string } | undefined;
    const result = await recordTranscriptionResult({
      messageId: id,
      ...("expectedLatestTranscriptionId" in data
        ? { expectedLatestTranscriptionId: expectedLatestTranscriptionId ?? null }
        : {}),
      ...("expectedLatestTranscriptionSha256" in data
        ? { expectedLatestTranscriptionSha256: expectedLatestTranscriptionSha256 ?? null }
        : {}),
      text,
      language: language ?? null,
      model: model ?? null,
      provider: "on_device",
      processDownstream: processDownstream ?? true,
      requestedByUserId: user?.id ?? null,
    });
    if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.outcome === "stale_transcription") {
      return c.json({ error: "stale_transcription" }, 409);
    }
    const row = await db.transcription.findUnique({ where: { id: result.transcriptionId } });
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(serializeTranscription(row), 202);
  },
);

// Operator-submitted moderation verdict: a logged-in operator's device (e.g.
// the iOS review app running Apple Intelligence) computed the verdict locally
// and records it here, rather than asking the server to re-run moderation
// through the configured upstream via `/moderate`. Mirrors the worker
// push-back semantics — a pending row is finalized — but attributes the row to
// the submitting operator and records a new succeeded row when nothing is
// pending, since an out-of-band verdict has no pending row to claim.
//
// Advisory only, exactly like the worker path: the verdict never changes the
// message's status beyond surfacing it for review. `POST /:id/decision`
// remains the only thing that decides a message.
messagesRouter.post(
  "/:id/moderation",
  zValidator("param", idParamSchema),
  zValidator("json", ModerationSubmitSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    recordAudit(c, {
      action: "message.moderation.submit",
      targetType: "message",
      targetId: id,
      metadata: {
        transcriptionId: data.transcriptionId ?? null,
        model: data.model ?? null,
        flagged: data.flagged,
        recommendation: data.recommendation,
        maxScore: data.maxScore,
      },
    });
    const user = c.get("user") as { id: string } | undefined;
    if (data.inputSha256 && data.transcriptionId) {
      const targetTranscriptionId = data.transcriptionId;
      const outcome = await db.$transaction(async (tx) => {
        if (!(await lockMessageForReview(tx, id))) return { outcome: "not_found" } as const;
        const transcription = await tx.transcription.findFirst({
          where: { id: targetTranscriptionId, messageId: id, status: "succeeded" },
        });
        if (!transcription) return { outcome: "transcription_not_found" } as const;
        const latestTranscription = await tx.transcription.findFirst({
          where: { messageId: id, status: "succeeded" },
          orderBy: { createdAt: "desc" },
        });
        if (latestTranscription?.id !== transcription.id) {
          return { outcome: "stale_transcription" } as const;
        }
        const input =
          transcription.translationStatus === "succeeded" &&
          typeof transcription.translatedText === "string" &&
          transcription.translatedText.trim().length > 0
            ? normalizeTranslationText(transcription.translatedText)
            : (transcription.text ?? "");
        const actualHash = createHash("sha256").update(input.trim(), "utf8").digest("hex");
        if (actualHash !== data.inputSha256) return { outcome: "stale_input" } as const;

        const now = new Date();
        const pending = await tx.moderation.findFirst({
          where: {
            messageId: id,
            transcriptionId: transcription.id,
            status: "pending",
          },
          orderBy: { createdAt: "desc" },
        });
        if (pending) {
          const updated = await tx.moderation.update({
            where: { id: pending.id },
            data: {
              provider: "on_device",
              model: data.model ?? null,
              status: "succeeded",
              flagged: data.flagged,
              recommendation: data.recommendation,
              maxScore: data.maxScore,
              categories: data.categories ?? {},
              reasonSummary: data.reasonSummary ?? null,
              latencyMs: now.getTime() - pending.createdAt.getTime(),
              completedAt: now,
              requestedById: user?.id ?? null,
            },
          });
          return { outcome: "recorded", moderationId: updated.id } as const;
        }
        const latest = await tx.moderation.findFirst({
          where: { messageId: id },
          orderBy: { createdAt: "desc" },
        });
        if (
          latest?.status === "succeeded" &&
          latest.transcriptionId === transcription.id &&
          latest.provider === "on_device" &&
          latest.flagged === data.flagged &&
          latest.recommendation === data.recommendation &&
          latest.maxScore === data.maxScore &&
          scoreMapsEqual(latest.categories, data.categories) &&
          (latest.reasonSummary ?? null) === (data.reasonSummary ?? null) &&
          (latest.model ?? null) === (data.model ?? null) &&
          (latest.requestedById ?? null) === (user?.id ?? null)
        ) {
          return { outcome: "recorded", moderationId: latest.id } as const;
        }
        const created = await tx.moderation.create({
          data: {
            messageId: id,
            transcriptionId: transcription.id,
            provider: "on_device",
            model: data.model ?? null,
            status: "succeeded",
            flagged: data.flagged,
            recommendation: data.recommendation,
            maxScore: data.maxScore,
            categories: data.categories ?? {},
            reasonSummary: data.reasonSummary ?? null,
            completedAt: now,
            requestedById: user?.id ?? null,
          },
        });
        return { outcome: "recorded", moderationId: created.id } as const;
      });
      if (outcome.outcome === "not_found") return c.json({ error: "not_found" }, 404);
      if (outcome.outcome === "transcription_not_found") {
        return c.json({ error: "transcription_not_found" }, 404);
      }
      if (outcome.outcome === "stale_transcription") {
        return c.json({ error: "stale_transcription" }, 409);
      }
      if (outcome.outcome === "stale_input") {
        return c.json({ error: "stale_moderation_input" }, 409);
      }
      const row = await db.moderation.findUnique({ where: { id: outcome.moderationId } });
      if (!row) return c.json({ error: "not_found" }, 404);
      await advanceMessageAfterModeration(id);
      await broadcastMessageById(id);
      void notifyMessageFlagged(id, row.id, row.flagged === true);
      return c.json(serializeModeration(row), 202);
    }
    const result = await recordModerationResult({
      messageId: id,
      transcriptionId: data.transcriptionId ?? null,
      flagged: data.flagged,
      recommendation: data.recommendation,
      maxScore: data.maxScore,
      categories: data.categories ?? null,
      reasonSummary: data.reasonSummary ?? null,
      model: data.model ?? null,
      provider: "on_device",
      requestedByUserId: user?.id ?? null,
      createWhenMissing: true,
    });
    if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.outcome === "transcription_not_found") {
      return c.json({ error: "transcription_not_found" }, 404);
    }
    if (result.outcome === "stale_transcription") {
      return c.json({ error: "stale_transcription" }, 409);
    }
    if (result.outcome === "stale_input") {
      return c.json({ error: "stale_moderation_input" }, 409);
    }
    if (result.moderationId === null) return c.json({ error: "not_found" }, 404);
    const row = await db.moderation.findUnique({ where: { id: result.moderationId } });
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(serializeModeration(row), 202);
  },
);

messagesRouter.post("/:id/moderate", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  recordAudit(c, { action: "message.moderation.request", targetType: "message", targetId: id });
  const message = await db.message.findUnique({ where: { id }, select: { id: true } });
  if (!message) return c.json({ error: "not_found" }, 404);
  const user = c.get("user") as { id: string } | undefined;
  const moderationId = await runModeration({
    messageId: id,
    requestedByUserId: user?.id ?? null,
  });
  if (!moderationId) return c.json({ error: "no_succeeded_transcription" }, 409);
  const row = await db.moderation.findUnique({ where: { id: moderationId } });
  if (!row) return c.json({ error: "not_found" }, 404);
  recordAudit(c, { metadata: { moderationId: row.id, provider: row.provider } });
  return c.json(serializeModeration(row), 202);
});

const messageWithAi = {
  audio: true,
  transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
  moderations: { orderBy: { createdAt: "desc" }, take: 1 },
} as const;

// Push the latest serialized message over the WebSocket so connected operators
// see status/transcription changes immediately. Mirrors the helpers in
// pipeline.ts and jobs.ts (their broadcasters are not exported for reuse).
const broadcastMessageById = async (messageId: string): Promise<void> => {
  const full = await db.message.findUnique({ where: { id: messageId }, include: messageWithAi });
  if (!full) return;
  wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(full) });
};

const lockMessageForReview = async (
  tx: Prisma.TransactionClient,
  messageId: string,
): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Message" WHERE "id" = ${messageId}::uuid FOR UPDATE
  `;
  return rows.length > 0;
};

const scoreMapsEqual = (
  stored: unknown,
  submitted: Record<string, number> | undefined,
): boolean => {
  const previous =
    stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const next = submitted ?? {};
  const keys = Object.keys(next);
  return (
    keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === next[key])
  );
};

// Human moderation decision: a logged-in operator approves or rejects a
// message, overriding (or standing in for) the AI pipeline. Only valid once
// the recording has landed — "uploading" messages have no content to judge.
messagesRouter.post(
  "/:id/decision",
  zValidator("param", idParamSchema),
  zValidator("json", MessageDecisionSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { decision, notes } = c.req.valid("json");
    // Named per outcome so the trail can be filtered by "who approved what".
    recordAudit(c, {
      action: decision === "approve" ? "message.approve" : "message.reject",
      targetType: "message",
      targetId: id,
      metadata: { decision, hasNotes: notes !== undefined },
    });
    const existing = await db.message.findUnique({
      where: { id },
      select: { id: true, status: true, installationId: true },
    });
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.status === "uploading") {
      return c.json({ error: "message_not_decidable" }, 409);
    }
    recordAudit(c, { metadata: { previousStatus: existing.status } });
    const user = c.get("user") as { id: string } | undefined;
    try {
      await withOpenEra(existing.installationId, (tx) =>
        tx.message.update({
          where: { id },
          data: {
            status: decision === "approve" ? "approved" : "rejected",
            decidedAt: new Date(),
            decidedById: user?.id ?? null,
            ...(notes !== undefined ? { notes } : {}),
          },
        }),
      );
    } catch (error) {
      if (error instanceof InstallationEndedError) {
        return c.json({ error: "installation_ended" }, 409);
      }
      throw error;
    }
    const message = await db.message.findUnique({ where: { id }, include: messageWithAi });
    if (!message) return c.json({ error: "not_found" }, 404);
    wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(message) });
    if (existing.status === "received" || existing.status === "pending") {
      void observeModerationQueue("message.decision");
    }
    return c.json(serializeMessage(message as never));
  },
);

// Human translation: attach an operator-supplied English translation to the
// message's latest succeeded transcription. Used when the translation worker
// could not produce one (unsupported language, failure, or no provider).
messagesRouter.post(
  "/:id/translation",
  zValidator("param", idParamSchema),
  zValidator("json", TranslationSubmitSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const {
      transcriptionId,
      expectedTranscriptionId,
      expectedTranslationSha256,
      translatedText,
      translatedLanguage,
      model,
    } = data;
    const normalizedTranslation = normalizeTranslationText(translatedText);
    recordAudit(c, {
      action: "message.translation.submit",
      targetType: "message",
      targetId: id,
      metadata: {
        translatedLanguage: translatedLanguage ?? null,
        translatedTextLength: normalizedTranslation.length,
        transcriptionId: transcriptionId ?? null,
        expectedTranscriptionId: expectedTranscriptionId ?? null,
        expectedTranslationSha256: expectedTranslationSha256 ?? null,
        model: model ?? null,
      },
    });
    const result = await recordTranslationResult({
      messageId: id,
      ...(transcriptionId ? { transcriptionId } : {}),
      ...(expectedTranscriptionId ? { expectedTranscriptionId } : {}),
      ...("expectedTranslationSha256" in data
        ? { expectedTranslationSha256: expectedTranslationSha256 ?? null }
        : {}),
      translatedText: normalizedTranslation,
      translatedLanguage: translatedLanguage ?? null,
      model: model ?? null,
      ...(transcriptionId ? { provider: "on_device" as const } : {}),
    });
    if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.outcome === "no_transcription") {
      return c.json({ error: "no_succeeded_transcription" }, 409);
    }
    if (result.outcome === "stale_transcription") {
      return c.json({ error: "stale_transcription" }, 409);
    }
    if (result.outcome === "stale_translation") {
      return c.json({ error: "stale_translation" }, 409);
    }
    const transcription = await db.transcription.findUnique({
      where: { id: result.transcriptionId },
    });
    if (!transcription) return c.json({ error: "not_found" }, 404);
    recordAudit(c, { metadata: { transcriptionId: transcription.id } });
    return c.json(serializeTranscription(transcription));
  },
);
