import { zValidator } from "@hono/zod-validator";
import { Prisma } from "../generated/prisma/client.js";
import {
  MessageCreateSchema,
  MessageDecisionSchema,
  MessageStatusSchema,
  TranslationSubmitSchema,
} from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { resolveAiConfig } from "../lib/ai/config.js";
import { recordAudit } from "../lib/audit.js";
import { kickPipelineForMessage, runModeration, runTranscription } from "../lib/ai/pipeline.js";
import { fanOutNotification } from "../lib/apns.js";
import { generateSasUrl, headBlob } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { countMessagesAwaitingModeration } from "../lib/moderation-badge.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";
import {
  serializeMessage,
  serializeModeration,
  serializeTranscription,
} from "../lib/serializers.js";
import type { AuthVariables } from "../lib/session.js";

const listQuerySchema = z.object({
  status: MessageStatusSchema.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const idParamSchema = z.object({ id: z.guid() });

const messageBlobName = (sha256: string): string => `messages/${sha256.slice(0, 2)}/${sha256}.flac`;

export const messagesRouter = new Hono<{ Variables: AuthVariables & ApiTokenVariables }>();

messagesRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { status, since, limit } = c.req.valid("query");
  const messages = await db.message.findMany({
    where: {
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

messagesRouter.delete("/:id", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  recordAudit(c, { action: "message.delete", targetType: "message", targetId: id });
  const existing = await db.message.findUnique({ where: { id } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  await db.message.delete({ where: { id } });
  recordAudit(c, { metadata: { previousStatus: existing.status } });
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
    if (!question || question.status !== "active")
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
    const { count } = await db.message.updateMany({
      where: { id, status: "uploading" },
      data: { status: "pending", receivedAt },
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
    void fanOutNotification({
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
      select: { id: true, status: true },
    });
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.status === "uploading") {
      return c.json({ error: "message_not_decidable" }, 409);
    }
    recordAudit(c, { metadata: { previousStatus: existing.status } });
    const user = c.get("user") as { id: string } | undefined;
    await db.message.update({
      where: { id },
      data: {
        status: decision === "approve" ? "approved" : "rejected",
        decidedAt: new Date(),
        decidedById: user?.id ?? null,
        ...(notes !== undefined ? { notes } : {}),
      },
    });
    const message = await db.message.findUnique({ where: { id }, include: messageWithAi });
    if (!message) return c.json({ error: "not_found" }, 404);
    wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(message) });
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
    const { translatedText, translatedLanguage } = c.req.valid("json");
    recordAudit(c, {
      action: "message.translation.submit",
      targetType: "message",
      targetId: id,
      metadata: {
        translatedLanguage: translatedLanguage ?? null,
        translatedTextLength: translatedText.length,
      },
    });
    const message = await db.message.findUnique({ where: { id }, select: { id: true } });
    if (!message) return c.json({ error: "not_found" }, 404);
    const latest = await db.transcription.findFirst({
      where: { messageId: id, status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    if (!latest) return c.json({ error: "no_succeeded_transcription" }, 409);
    recordAudit(c, { metadata: { transcriptionId: latest.id } });
    const updated = await db.transcription.update({
      where: { id: latest.id },
      data: {
        translationStatus: "succeeded",
        translatedText,
        translatedLanguage: translatedLanguage ?? null,
        // Human-supplied translation: no AI provider/model. Consumers infer a
        // manual translation from a succeeded translation with a null provider.
        translationProvider: null,
        translationModel: null,
        translationError: null,
        translationCompletedAt: new Date(),
      },
    });
    await broadcastMessageById(id);
    return c.json(serializeTranscription(updated));
  },
);
