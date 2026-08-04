// Push-mode result callbacks for the Transcription worker (macOS + iOS).
//
// This is the receiving half of the push model that replaces the old
// `/v1/jobs/*` pull queue. The worker subscribes to the status WebSocket,
// reacts to `{ kind: "work", messageId, needs }` envelopes by running the
// named steps locally, then POSTs the result back here. Authentication is the
// same static Argon2id API token used elsewhere by native clients
// (`requireApiToken`).
//
// Unlike the pull queue there are no leases. Translation and moderation are
// still solicited via `work` events; transcription is not — the app pushes one
// whenever it has it. Every write is guarded so a stale or duplicate callback
// cannot create a newer row or downgrade a finalized one.

import { zValidator } from "@hono/zod-validator";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../lib/audit.js";
import { db } from "../lib/db.js";
import {
  recordModerationResult,
  recordTranscriptionResult,
  runModeration,
} from "../lib/ai/pipeline.js";
import { generateSasUrl } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { serializeMessage } from "../lib/serializers.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";

const idParamSchema = z.object({ id: z.guid() });

const transcriptionBody = z.object({
  transcriptionId: z.guid().nullable().optional(),
  expectedLatestTranscriptionId: z.guid().nullable().optional(),
  text: z.string(),
  language: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

const translationBody = z.object({
  transcriptionId: z.string().min(1),
  translatedText: z.string(),
  sourceLanguage: z.string().nullable().optional(),
  targetLanguage: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

const moderationBody = z
  .object({
    transcriptionId: z.guid().nullable().optional(),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    flagged: z.boolean(),
    recommendation: z.enum(["approve", "review", "reject"]),
    maxScore: z.number().min(0).max(1),
    categories: z.record(z.string(), z.number()).optional(),
    reasonSummary: z.string().optional(),
    model: z.string().nullable().optional(),
  })
  .refine((body) => (body.inputSha256 == null) === (body.transcriptionId == null), {
    message: "transcriptionId and inputSha256 must be supplied together",
    path: ["transcriptionId"],
  });

// Broadcast the latest serialized message so connected operators see status
// changes immediately. Mirrors the helper in pipeline.ts / messages.ts.
const broadcastMessageById = async (messageId: string): Promise<void> => {
  const full = await db.message.findUnique({
    where: { id: messageId },
    include: {
      audio: true,
      transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
      moderations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!full) return;
  wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(full) });
};

// This surface is gated by `requireApiToken("worker")` (see below): only a
// worker-scoped token may reach it, and such tokens receive nothing but `work`
// events on the status WebSocket.

export const workerRouter = new Hono<{ Variables: ApiTokenVariables }>();

workerRouter.use("*", requireApiToken("worker"));

// GET /v1/worker/messages/:id/work — fetch the inputs the worker needs to run
// the next step for a message. The `work` WS envelope deliberately carries only
// `{ messageId, needs }` (never a SAS URL, since the status channel is shared
// with browser operators); the worker pulls the actual inputs here over its
// authenticated connection. Claim-free and read-only: it just reflects the
// message's current state so the worker can transcribe / translate / moderate.
workerRouter.get("/messages/:id/work", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const message = await db.message.findUnique({
    where: { id },
    include: {
      audio: true,
      transcriptions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!message) return c.json({ error: "not_found" }, 404);

  const transcription = message.transcriptions[0] ?? null;
  const audio = message.audio;
  const audioBody = audio
    ? {
        url: generateSasUrl(audio.blobKey, { permissions: "r" as const }).url,
        sha256: audio.sha256,
        durationMs: audio.durationMs,
        contentType: audio.contentType,
        filename: `${audio.sha256}.flac`,
      }
    : null;

  // The text to moderate is the English translation when available, else the
  // original transcript. Mirrors the old pull-queue moderation payload.
  const moderationText = (
    transcription?.translationStatus === "succeeded" &&
    typeof transcription.translatedText === "string" &&
    transcription.translatedText.trim().length > 0
      ? transcription.translatedText
      : (transcription?.text ?? "")
  ).trim();
  const moderationInputSha256 = createHash("sha256").update(moderationText, "utf8").digest("hex");

  return c.json({
    id: message.id,
    status: message.status,
    audio: audioBody,
    transcription: transcription
      ? {
          id: transcription.id,
          text: transcription.text ?? "",
          language: transcription.language,
          model: transcription.model,
          translationStatus: transcription.translationStatus,
          translatedText: transcription.translatedText,
          moderationText,
          moderationInputSha256,
        }
      : null,
  });
});

// POST /v1/worker/messages/:id/transcription — the app finished transcribing
// the message audio and is pushing the text back.
//
// Transcriptions are unsolicited by design: the message is already `pending`
// in the operator queue and the app decides on its own when (or whether) to
// transcribe. So when there is no pending row to finalize we record a new
// succeeded one rather than dropping the text on the floor. The shared
// `recordTranscriptionResult` helper owns this logic (and guards against stale
// or duplicate callbacks); the operator submit route reuses it.
workerRouter.post(
  "/messages/:id/transcription",
  zValidator("param", idParamSchema),
  zValidator("json", transcriptionBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    // Transcript text stays in the Transcription row; the trail records that a
    // transcription landed, by whom, and from where — not the content itself.
    recordAudit(c, {
      action: "message.transcription.push",
      targetType: "message",
      targetId: id,
      metadata: {
        model: data.model ?? null,
        language: data.language ?? null,
        textLength: data.text.length,
      },
    });
    const result = await recordTranscriptionResult({
      messageId: id,
      transcriptionId: data.transcriptionId ?? null,
      ...("expectedLatestTranscriptionId" in data
        ? { expectedLatestTranscriptionId: data.expectedLatestTranscriptionId ?? null }
        : {}),
      text: data.text,
      language: data.language ?? null,
      model: data.model ?? null,
    });
    if (result.outcome === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.outcome === "stale_transcription") {
      return c.json({ error: "stale_transcription" }, 409);
    }
    return c.json({ ok: true });
  },
);

// POST /v1/worker/messages/:id/translation — the worker finished translating
// the transcript to English.
workerRouter.post(
  "/messages/:id/translation",
  zValidator("param", idParamSchema),
  zValidator("json", translationBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    recordAudit(c, {
      action: "message.translation.push",
      targetType: "message",
      targetId: id,
      metadata: {
        transcriptionId: data.transcriptionId,
        model: data.model ?? null,
        targetLanguage: data.targetLanguage ?? "en",
        translatedTextLength: data.translatedText.length,
      },
    });
    const existing = await db.transcription.findUnique({
      where: { id: data.transcriptionId },
    });
    if (!existing || existing.messageId !== id) {
      return c.json({ error: "not_found" }, 404);
    }
    const updated = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Message" WHERE "id" = ${id}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return 0;
      const current = await tx.transcription.findUnique({ where: { id: existing.id } });
      const latest = await tx.transcription.findFirst({
        where: { messageId: id, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!current || !latest || latest.id !== current.id) return 0;
      const previousReviewText =
        current.translationStatus === "succeeded" &&
        typeof current.translatedText === "string" &&
        current.translatedText.trim().length > 0
          ? current.translatedText
          : current.text;
      const now = new Date();
      const result = await tx.transcription.updateMany({
        where: { id: current.id, translationStatus: "pending" },
        data: {
          translationStatus: "succeeded",
          translatedText: data.translatedText,
          translatedLanguage: data.targetLanguage ?? "en",
          translationModel: data.model ?? current.translationModel,
          translationLatencyMs: now.getTime() - current.createdAt.getTime(),
          translationCompletedAt: now,
          translationError: null,
        },
      });
      if (result.count > 0 && previousReviewText?.trim() !== data.translatedText.trim()) {
        await tx.moderation.updateMany({
          where: {
            messageId: id,
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
      return result.count;
    });
    if (updated === 0) return c.json({ ok: true });
    await broadcastMessageById(id);
    // Translation done — provider-aware moderation can now run against English
    // text. Push mode emits work; in-process providers run immediately.
    await runModeration({
      messageId: id,
      transcriptionId: existing.id,
      requestedByUserId: null,
    });
    return c.json({ ok: true });
  },
);

// POST /v1/worker/messages/:id/moderation — the worker finished moderating and
// is pushing the ADVISORY suggestion back. This never decides the message: a
// human operator always calls POST /v1/messages/:id/decision.
workerRouter.post(
  "/messages/:id/moderation",
  zValidator("param", idParamSchema),
  zValidator("json", moderationBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    recordAudit(c, {
      action: "message.moderation.push",
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
    const result = await recordModerationResult({
      messageId: id,
      ...(data.transcriptionId !== undefined ? { transcriptionId: data.transcriptionId } : {}),
      flagged: data.flagged,
      recommendation: data.recommendation,
      maxScore: data.maxScore,
      categories: data.categories ?? null,
      reasonSummary: data.reasonSummary ?? null,
      model: data.model ?? null,
      ...(data.inputSha256 !== undefined ? { inputSha256: data.inputSha256 } : {}),
      // Worker moderation is solicited: `runModeration` creates the pending
      // row before emitting the `work` event, so a callback with nothing
      // pending is stale and is dropped rather than resurrected.
      createWhenMissing: false,
    });
    if (result.outcome === "not_found" || result.outcome === "transcription_not_found") {
      return c.json({ error: "not_found" }, 404);
    }
    if (result.outcome === "stale_transcription") {
      return c.json({ error: "stale_transcription" }, 409);
    }
    if (result.outcome === "stale_input") {
      return c.json({ error: "stale_moderation_input" }, 409);
    }
    return c.json({ ok: true });
  },
);
