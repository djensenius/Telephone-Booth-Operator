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
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import {
  advanceMessageAfterModeration,
  runModeration,
  runTranslationThenModeration,
} from "../lib/ai/pipeline.js";
import { generateSasUrl } from "../lib/azure-blob.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { serializeMessage } from "../lib/serializers.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";

const idParamSchema = z.object({ id: z.guid() });

const transcriptionBody = z.object({
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

const moderationBody = z.object({
  transcriptionId: z.string().min(1).nullable().optional(),
  flagged: z.boolean(),
  recommendation: z.enum(["approve", "review", "reject"]),
  maxScore: z.number().min(0).max(1),
  categories: z.record(z.string(), z.number()).optional(),
  reasonSummary: z.string().optional(),
  model: z.string().nullable().optional(),
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

// Nudge a message from "received" into the operator queue without deciding it.
const advanceReceivedMessage = async (messageId: string): Promise<void> => {
  const current = await db.message.findUnique({
    where: { id: messageId },
    select: { status: true },
  });
  if (current?.status === "received") {
    await db.message.update({ where: { id: messageId }, data: { status: "pending" } });
  }
};

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
  const moderationText =
    transcription?.translationStatus === "succeeded" &&
    typeof transcription.translatedText === "string" &&
    transcription.translatedText.trim().length > 0
      ? transcription.translatedText
      : (transcription?.text ?? "");

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
// succeeded one rather than dropping the text on the floor.
workerRouter.post(
  "/messages/:id/transcription",
  zValidator("param", idParamSchema),
  zValidator("json", transcriptionBody),
  async (c) => {
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const message = await db.message.findUnique({
      where: { id },
      select: { id: true, audio: { select: { durationMs: true } } },
    });
    if (!message) return c.json({ error: "not_found" }, 404);

    const pending = await db.transcription.findFirst({
      where: { messageId: id, status: "pending" },
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
          text: data.text,
          language: data.language ?? null,
          model: data.model ?? pending.model,
          latencyMs: now.getTime() - startedAt.getTime(),
          completedAt: now,
        },
      });
      if (updated.count === 0) return c.json({ ok: true });
      transcriptionId = pending.id;
    } else {
      // Unsolicited push: no row was ever requested for this message.
      //
      // Retries must not duplicate history. Without a pending row to consume,
      // an identical redelivery (network timeout, app restart mid-POST) would
      // otherwise create a second succeeded row and re-run translation and
      // moderation. Treat a repeat of the latest succeeded transcript as the
      // no-op it is; a genuinely different transcript still records a new
      // attempt.
      const latest = await db.transcription.findFirst({
        where: { messageId: id },
        orderBy: { createdAt: "desc" },
      });
      if (latest?.status === "succeeded" && (latest.text ?? "").trim() === data.text.trim()) {
        return c.json({ ok: true });
      }
      // The app owns the latency here, so we do not invent one.
      const created = await db.transcription.create({
        data: {
          messageId: id,
          provider: "push",
          model: data.model ?? null,
          status: "succeeded",
          text: data.text,
          language: data.language ?? null,
          durationMs: message.audio?.durationMs ?? null,
          completedAt: now,
        },
      });
      transcriptionId = created.id;
    }

    await broadcastMessageById(id);

    const hasText = data.text.trim().length > 0;
    if (!hasText) {
      // Silent recording: nothing to translate or moderate. Legacy `received`
      // messages still need surfacing; anything newer is already `pending`.
      await advanceReceivedMessage(id);
      await broadcastMessageById(id);
      return c.json({ ok: true });
    }

    await runTranslationThenModeration({
      messageId: id,
      transcriptionId,
    });
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
    const existing = await db.transcription.findUnique({
      where: { id: data.transcriptionId },
    });
    if (!existing || existing.messageId !== id) {
      return c.json({ error: "not_found" }, 404);
    }
    const now = new Date();
    const startedAt = existing.createdAt;
    // Guard: only the pending push row can be finalized. Duplicate or stale
    // callbacks for already-finalized / non-pending rows are idempotent no-ops.
    const updated = await db.transcription.updateMany({
      where: { id: existing.id, translationStatus: "pending" },
      data: {
        translationStatus: "succeeded",
        translatedText: data.translatedText,
        translatedLanguage: data.targetLanguage ?? "en",
        translationModel: data.model ?? existing.translationModel,
        translationLatencyMs: now.getTime() - startedAt.getTime(),
        translationCompletedAt: now,
        translationError: null,
      },
    });
    if (updated.count === 0) return c.json({ ok: true });
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
    const message = await db.message.findUnique({ where: { id }, select: { id: true } });
    if (!message) return c.json({ error: "not_found" }, 404);

    const pending = data.transcriptionId
      ? await db.moderation.findFirst({
          where: { messageId: id, transcriptionId: data.transcriptionId, status: "pending" },
          orderBy: { createdAt: "desc" },
        })
      : await db.moderation.findFirst({
          where: { messageId: id, status: "pending" },
          orderBy: { createdAt: "desc" },
        });
    const now = new Date();
    if (pending) {
      const startedAt = pending.createdAt;
      const updated = await db.moderation.updateMany({
        where: { id: pending.id, status: "pending" },
        data: {
          status: "succeeded",
          flagged: data.flagged,
          recommendation: data.recommendation,
          maxScore: data.maxScore,
          categories: data.categories ?? {},
          reasonSummary: data.reasonSummary ?? null,
          model: data.model ?? pending.model,
          latencyMs: now.getTime() - startedAt.getTime(),
          completedAt: now,
        },
      });
      if (updated.count === 0) return c.json({ ok: true });
    } else {
      return c.json({ ok: true });
    }
    // Advisory only: record the suggestion and surface the message for a human
    // decision. Never auto-approve / auto-reject.
    await advanceMessageAfterModeration(id);
    await broadcastMessageById(id);
    return c.json({ ok: true });
  },
);
