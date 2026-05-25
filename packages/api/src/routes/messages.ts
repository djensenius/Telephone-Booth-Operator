import { zValidator } from "@hono/zod-validator";
import { Prisma } from "@prisma/client";
import { MessageCreateSchema, MessageStatusSchema } from "@telephone-booth-operator/shared";
import { Hono } from "hono";
import { z } from "zod";
import { kickPipelineForMessage, runModeration, runTranscription } from "../lib/ai/pipeline.js";
import { fanOutNotification } from "../lib/apns.js";
import { generateSasUrl, headBlob } from "../lib/azure-blob.js";
import { db } from "../lib/db.js";
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

const idParamSchema = z.object({ id: z.string().uuid() });

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
  const existing = await db.message.findUnique({ where: { id } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  await db.message.delete({ where: { id } });
  return c.body(null, 204);
});

messagesRouter.post("/", requireApiToken(), zValidator("json", MessageCreateSchema), async (c) => {
  const body = c.req.valid("json");
  if (body.questionId) {
    const question = await db.question.findUnique({ where: { id: body.questionId } });
    if (!question || question.retiredAt) return c.json({ error: "question_not_found" }, 404);
  }

  const blobName = messageBlobName(body.sha256);
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
  if (existingMessage) return c.json({ error: "message_already_exists" }, 409);

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
      return c.json({ error: "message_already_exists" }, 409);
    }
    throw err;
  }
  const sas = generateSasUrl(blobName, { permissions: "cw", contentType: "audio/flac" });
  return c.json({ id: message.id, uploadUrl: sas.url, blobName }, 201);
});

messagesRouter.post(
  "/:id/complete",
  requireApiToken(),
  zValidator("param", idParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const message = await db.message.findUnique({ where: { id }, include: { audio: true } });
    if (!message) return c.json({ error: "not_found" }, 404);

    const blob = await headBlob(message.audio.blobKey);
    if (!blob.exists) return c.json({ error: "blob_not_found" }, 409);
    if (blob.sha256 && blob.sha256 !== message.audio.sha256)
      return c.json({ error: "sha256_mismatch" }, 422);

    await db.file.update({
      where: { id: message.audio.id },
      data: {
        sizeBytes: blob.sizeBytes,
        contentType: blob.contentType ?? message.audio.contentType,
      },
    });

    // Idempotent transition: only move from "uploading" → "received".
    // If the message already advanced past "uploading" (e.g. retry after
    // timeout), skip the pipeline and return the current state.
    const receivedAt = new Date();
    const { count } = await db.message.updateMany({
      where: { id, status: "uploading" },
      data: { status: "received", receivedAt },
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
    kickPipelineForMessage(id);
    // Push fan-out: notify mobile devices that a new message has landed.
    void fanOutNotification({
      preferenceKey: "messageReceived",
      title: "New booth message",
      body: "A new recording is ready to moderate.",
      threadId: `message:${id}`,
      category: "BOOTH_MESSAGE",
      data: { messageId: id },
    });
    return c.json({ id, status: "received", receivedAt: receivedAt.toISOString() });
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
  return c.json(serializeTranscription(row), 202);
});

messagesRouter.post("/:id/moderate", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
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
  return c.json(serializeModeration(row), 202);
});
