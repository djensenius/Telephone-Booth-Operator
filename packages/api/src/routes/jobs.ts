// Outbound job queue for the Mac-app pull worker model.
//
// The Mac transcription app polls this surface every few seconds, atomically
// leases a single pending unit of work (a transcription, translation, or
// moderation row), runs it locally, and posts the result back. This is the
// inverse of the original push-in model where the Operator called *out* to
// the Mac app. Both models coexist; pull mode is opt-in on the worker side.
//
// Concurrency model: claim-with-lease. Each `GET /v1/jobs/next` issues a
// random `leaseToken` and bumps `leaseExpiresAt`. Subsequent `/succeed`,
// `/fail`, `/heartbeat` calls require the same token, so a stale worker
// cannot overwrite a row another worker has since re-leased.

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateSasUrl } from "../lib/azure-blob.js";
import { db } from "../lib/db.js";
import { isEnglishLanguage } from "../lib/ai/config.js";
import { applyAutoDecision, buildDefaultPipelineDeps } from "../lib/ai/pipeline.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { serializeMessage } from "../lib/serializers.js";
import { requireApiToken, type ApiTokenVariables } from "../lib/require-api-token.js";

const KIND_TRANSCRIPTION = "transcription";
const KIND_TRANSLATION = "translation";
const KIND_MODERATION = "moderation";
type JobKind = "transcription" | "translation" | "moderation";

const ALL_KINDS: readonly JobKind[] = [
  KIND_TRANSCRIPTION,
  KIND_TRANSLATION,
  KIND_MODERATION,
] as const;

const ATTEMPT_CAP = 5;

// Send the latest serialized message over the WebSocket so connected
// operators see status changes immediately. Mirrors the helper in
// pipeline.ts; kept local because the pipeline's broadcaster is not
// exported.
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
  wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(full as never) });
};

const nextQuerySchema = z.object({
  // Comma-separated subset of "transcription,translation,moderation". When
  // omitted, all kinds are eligible.
  kinds: z
    .string()
    .optional()
    .transform((raw) => raw?.trim() ?? "")
    .pipe(
      z
        .string()
        .transform((raw) => {
          if (raw.length === 0) return [...ALL_KINDS];
          const parts = raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          const out: JobKind[] = [];
          for (const part of parts) {
            if (
              (part === KIND_TRANSCRIPTION ||
                part === KIND_TRANSLATION ||
                part === KIND_MODERATION) &&
              !out.includes(part)
            ) {
              out.push(part);
            }
          }
          return out.length === 0 ? [...ALL_KINDS] : out;
        }),
    ),
  // 10-3600s. Default 60s — matches the worker's expected runtime budget.
  leaseSeconds: z.coerce.number().int().min(10).max(3600).default(60),
});

const idParamSchema = z.object({
  // Job IDs are `{kind}-{rowId}` so the worker can route succeed/fail back
  // without holding extra state. We validate the shape but keep parsing in
  // the handler.
  id: z.string().min(8),
});

const leaseTokenSchema = z.string().min(8);

const succeedTranscriptionBody = z.object({
  leaseToken: leaseTokenSchema,
  text: z.string(),
  language: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

const succeedTranslationBody = z.object({
  leaseToken: leaseTokenSchema,
  translatedText: z.string(),
  sourceLanguage: z.string().nullable().optional(),
  targetLanguage: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

const succeedModerationBody = z.object({
  leaseToken: leaseTokenSchema,
  flagged: z.boolean(),
  recommendation: z.enum(["approve", "review", "reject"]),
  maxScore: z.number().min(0).max(1),
  categories: z.record(z.number()).optional(),
  reasonSummary: z.string().optional(),
  model: z.string().nullable().optional(),
});

const failBody = z.object({
  leaseToken: leaseTokenSchema,
  errorCode: z.string().min(1).max(128),
  errorMessage: z.string().max(2000).optional(),
});

const heartbeatBody = z.object({
  leaseToken: leaseTokenSchema,
  leaseSeconds: z.coerce.number().int().min(10).max(3600).default(60),
});

const parseJobId = (jobId: string): { kind: JobKind; rowId: string } | null => {
  const dash = jobId.indexOf("-");
  if (dash <= 0) return null;
  const prefix = jobId.slice(0, dash);
  const rowId = jobId.slice(dash + 1);
  if (rowId.length === 0) return null;
  if (prefix !== KIND_TRANSCRIPTION && prefix !== KIND_TRANSLATION && prefix !== KIND_MODERATION) {
    return null;
  }
  return { kind: prefix, rowId };
};

const jobIdFor = (kind: JobKind, rowId: string): string => `${kind}-${rowId}`;

const claimTranscription = async (
  leaseToken: string,
  leaseSeconds: number,
): Promise<{ rowId: string } | null> => {
  const now = new Date();
  const expiry = new Date(now.getTime() + leaseSeconds * 1000);
  const candidate = await db.transcription.findFirst({
    where: {
      status: "pending",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      attemptCount: { lt: ATTEMPT_CAP },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const claimed = await db.transcription.updateMany({
    where: {
      id: candidate.id,
      status: "pending",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      leaseToken,
      leaseExpiresAt: expiry,
      leasedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return { rowId: candidate.id };
};

const claimTranslation = async (
  leaseToken: string,
  leaseSeconds: number,
): Promise<{ rowId: string } | null> => {
  const now = new Date();
  const expiry = new Date(now.getTime() + leaseSeconds * 1000);
  const candidate = await db.transcription.findFirst({
    where: {
      translationStatus: "pending",
      OR: [
        { translationLeaseExpiresAt: null },
        { translationLeaseExpiresAt: { lt: now } },
      ],
      translationAttemptCount: { lt: ATTEMPT_CAP },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const claimed = await db.transcription.updateMany({
    where: {
      id: candidate.id,
      translationStatus: "pending",
      OR: [
        { translationLeaseExpiresAt: null },
        { translationLeaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      translationLeaseToken: leaseToken,
      translationLeaseExpiresAt: expiry,
      translationLeasedAt: now,
      translationAttemptCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return { rowId: candidate.id };
};

const claimModeration = async (
  leaseToken: string,
  leaseSeconds: number,
): Promise<{ rowId: string } | null> => {
  const now = new Date();
  const expiry = new Date(now.getTime() + leaseSeconds * 1000);
  // A moderation row can only be claimed once its linked transcription's
  // translation step is no longer pending — otherwise we'd moderate the
  // pre-translation text and clobber the operator's auto-decision before
  // the translated text arrives. Rows with no linked transcription, or
  // whose translation is already succeeded / failed / not needed, are
  // eligible immediately.
  const candidate = await db.moderation.findFirst({
    where: {
      status: "pending",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      attemptCount: { lt: ATTEMPT_CAP },
      transcription: {
        is: {
          OR: [
            { translationStatus: null },
            { translationStatus: { not: "pending" } },
          ],
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const claimed = await db.moderation.updateMany({
    where: {
      id: candidate.id,
      status: "pending",
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      // Re-assert the translation-not-pending guard atomically so a
      // concurrent re-translation can't sneak the row into the moderation
      // queue between the findFirst above and the updateMany here.
      transcription: {
        is: {
          OR: [
            { translationStatus: null },
            { translationStatus: { not: "pending" } },
          ],
        },
      },
    },
    data: {
      leaseToken,
      leaseExpiresAt: expiry,
      leasedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count === 0) return null;
  return { rowId: candidate.id };
};

const buildTranscriptionJobPayload = async (rowId: string) => {
  const row = await db.transcription.findUnique({
    where: { id: rowId },
    include: { message: { include: { audio: true } } },
  });
  if (!row) return null;
  const audio = row.message.audio;
  const sas = generateSasUrl(audio.blobKey, { permissions: "r" });
  return {
    id: jobIdFor(KIND_TRANSCRIPTION, row.id),
    kind: KIND_TRANSCRIPTION,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    attempt: row.attemptCount,
    transcription: {
      messageId: row.messageId,
      audioUrl: sas.url,
      sha256: audio.sha256,
      durationMs: audio.durationMs,
      contentType: audio.contentType,
      filename: `${audio.sha256}.flac`,
      model: row.model,
      language: row.language,
    },
  };
};

const buildTranslationJobPayload = async (rowId: string) => {
  const row = await db.transcription.findUnique({ where: { id: rowId } });
  if (!row) return null;
  return {
    id: jobIdFor(KIND_TRANSLATION, row.id),
    kind: KIND_TRANSLATION,
    leaseToken: row.translationLeaseToken,
    leaseExpiresAt: row.translationLeaseExpiresAt?.toISOString() ?? null,
    attempt: row.translationAttemptCount,
    translation: {
      messageId: row.messageId,
      transcriptionId: row.id,
      text: row.text ?? "",
      sourceLanguage: row.language,
      targetLanguage: "en",
      model: row.translationModel,
    },
  };
};

const buildModerationJobPayload = async (rowId: string) => {
  const row = await db.moderation.findUnique({
    where: { id: rowId },
    include: { transcription: true },
  });
  if (!row) return null;
  const text =
    row.transcription?.translationStatus === "succeeded" &&
    typeof row.transcription.translatedText === "string" &&
    row.transcription.translatedText.trim().length > 0
      ? row.transcription.translatedText
      : (row.transcription?.text ?? "");
  return {
    id: jobIdFor(KIND_MODERATION, row.id),
    kind: KIND_MODERATION,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    attempt: row.attemptCount,
    moderation: {
      messageId: row.messageId,
      transcriptionId: row.transcriptionId,
      text,
      model: row.model,
    },
  };
};

export const jobsRouter = new Hono<{ Variables: ApiTokenVariables }>();

jobsRouter.use("*", requireApiToken());

jobsRouter.get("/next", zValidator("query", nextQuerySchema), async (c) => {
  const { kinds, leaseSeconds } = c.req.valid("query");
  const leaseToken = randomUUID();

  // Iterate kinds in caller-specified order; the first successful claim wins.
  for (const kind of kinds) {
    let claim: { rowId: string } | null = null;
    if (kind === KIND_TRANSCRIPTION) {
      claim = await claimTranscription(leaseToken, leaseSeconds);
    } else if (kind === KIND_TRANSLATION) {
      claim = await claimTranslation(leaseToken, leaseSeconds);
    } else if (kind === KIND_MODERATION) {
      claim = await claimModeration(leaseToken, leaseSeconds);
    }
    if (claim) {
      let payload: unknown = null;
      if (kind === KIND_TRANSCRIPTION) payload = await buildTranscriptionJobPayload(claim.rowId);
      else if (kind === KIND_TRANSLATION) payload = await buildTranslationJobPayload(claim.rowId);
      else if (kind === KIND_MODERATION) payload = await buildModerationJobPayload(claim.rowId);
      if (!payload) {
        // Row disappeared between claim and read — extremely unlikely; treat
        // as "nothing to do" rather than 500.
        continue;
      }
      return c.json(payload);
    }
  }
  return c.body(null, 204);
});

jobsRouter.post(
  "/:id/heartbeat",
  zValidator("param", idParamSchema),
  zValidator("json", heartbeatBody),
  async (c) => {
    const parsed = parseJobId(c.req.valid("param").id);
    if (!parsed) return c.json({ error: "not_found" }, 404);
    const { leaseToken, leaseSeconds } = c.req.valid("json");
    const expiry = new Date(Date.now() + leaseSeconds * 1000);

    if (parsed.kind === KIND_TRANSCRIPTION) {
      const updated = await db.transcription.updateMany({
        where: { id: parsed.rowId, leaseToken, status: "pending" },
        data: { leaseExpiresAt: expiry },
      });
      if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    } else if (parsed.kind === KIND_TRANSLATION) {
      const updated = await db.transcription.updateMany({
        where: {
          id: parsed.rowId,
          translationLeaseToken: leaseToken,
          translationStatus: "pending",
        },
        data: { translationLeaseExpiresAt: expiry },
      });
      if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    } else {
      const updated = await db.moderation.updateMany({
        where: { id: parsed.rowId, leaseToken, status: "pending" },
        data: { leaseExpiresAt: expiry },
      });
      if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    }
    return c.json({ ok: true, leaseExpiresAt: expiry.toISOString() });
  },
);

jobsRouter.post("/:id/succeed", zValidator("param", idParamSchema), async (c) => {
  const parsed = parseJobId(c.req.valid("param").id);
  if (!parsed) return c.json({ error: "not_found" }, 404);
  const rawBody: unknown = await c.req.json().catch(() => null);
  if (!rawBody || typeof rawBody !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }

  if (parsed.kind === KIND_TRANSCRIPTION) {
    const parsedBody = succeedTranscriptionBody.safeParse(rawBody);
    if (!parsedBody.success) return c.json({ error: "invalid_body" }, 400);
    const data = parsedBody.data;
    // Read for context only; the *binding* check happens in the conditional
    // updateMany below so a re-leased row is detected atomically.
    const existing = await db.transcription.findUnique({ where: { id: parsed.rowId } });
    if (!existing) return c.json({ error: "not_found" }, 404);
    const startedAt = existing.leasedAt ?? existing.createdAt;
    const updated = await db.transcription.updateMany({
      where: {
        id: parsed.rowId,
        status: "pending",
        leaseToken: data.leaseToken,
      },
      data: {
        status: "succeeded",
        text: data.text,
        language: data.language ?? null,
        model: data.model ?? existing.model,
        latencyMs: Date.now() - startedAt.getTime(),
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    // Kick the downstream steps: mark translation pending (if non-English)
    // and create a pending moderation row. Both will be picked up by the
    // worker on the next /next poll. claimModeration refuses to lease a
    // moderation whose linked transcription has translationStatus =
    // "pending", so the order between these writes does not race.
    if (data.text.trim().length > 0 && !isEnglishLanguage(data.language)) {
      await db.transcription.update({
        where: { id: parsed.rowId },
        data: { translationStatus: "pending" },
      });
    }
    if (data.text.trim().length > 0) {
      await db.moderation.create({
        data: {
          messageId: existing.messageId,
          transcriptionId: parsed.rowId,
          provider: "mac_app",
          model: null,
          status: "pending",
          requestedById: null,
        },
      });
    } else {
      // Silent recording: advance the message into the operator queue.
      const current = await db.message.findUnique({
        where: { id: existing.messageId },
        select: { status: true },
      });
      if (current?.status === "received") {
        await db.message.update({
          where: { id: existing.messageId },
          data: { status: "pending" },
        });
      }
    }
    await broadcastMessageById(existing.messageId);
    return c.json({ ok: true });
  }

  if (parsed.kind === KIND_TRANSLATION) {
    const parsedBody = succeedTranslationBody.safeParse(rawBody);
    if (!parsedBody.success) return c.json({ error: "invalid_body" }, 400);
    const data = parsedBody.data;
    const existing = await db.transcription.findUnique({ where: { id: parsed.rowId } });
    if (!existing) return c.json({ error: "not_found" }, 404);
    const startedAt = existing.translationLeasedAt ?? existing.createdAt;
    const updated = await db.transcription.updateMany({
      where: {
        id: parsed.rowId,
        translationStatus: "pending",
        translationLeaseToken: data.leaseToken,
      },
      data: {
        translationStatus: "succeeded",
        translatedText: data.translatedText,
        translatedLanguage: data.targetLanguage ?? "en",
        translationModel: data.model ?? existing.translationModel,
        translationLatencyMs: Date.now() - startedAt.getTime(),
        translationCompletedAt: new Date(),
        translationError: null,
        translationLeaseToken: null,
        translationLeaseExpiresAt: null,
      },
    });
    if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    await broadcastMessageById(existing.messageId);
    return c.json({ ok: true });
  }

  // moderation
  const parsedBody = succeedModerationBody.safeParse(rawBody);
  if (!parsedBody.success) return c.json({ error: "invalid_body" }, 400);
  const data = parsedBody.data;
  const existing = await db.moderation.findUnique({ where: { id: parsed.rowId } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  const startedAt = existing.leasedAt ?? existing.createdAt;
  const updated = await db.moderation.updateMany({
    where: {
      id: parsed.rowId,
      status: "pending",
      leaseToken: data.leaseToken,
    },
    data: {
      status: "succeeded",
      flagged: data.flagged,
      recommendation: data.recommendation,
      maxScore: data.maxScore,
      categories: data.categories ?? {},
      reasonSummary: data.reasonSummary ?? null,
      model: data.model ?? existing.model,
      latencyMs: Date.now() - startedAt.getTime(),
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
  // Apply the operator's configured auto-decision logic using the result
  // we just persisted; broadcast so connected operators see the update.
  const autoDecisionPayload: {
    recommendation: "approve" | "review" | "reject";
    flagged: boolean;
    maxScore: number;
    reasonSummary?: string;
  } = {
    recommendation: data.recommendation,
    flagged: data.flagged,
    maxScore: data.maxScore,
    ...(data.reasonSummary !== undefined ? { reasonSummary: data.reasonSummary } : {}),
  };
  await applyAutoDecision(
    existing.messageId,
    buildDefaultPipelineDeps(),
    autoDecisionPayload,
  ).catch(() => null);
  await broadcastMessageById(existing.messageId);
  return c.json({ ok: true });
});

jobsRouter.post(
  "/:id/fail",
  zValidator("param", idParamSchema),
  zValidator("json", failBody),
  async (c) => {
    const parsed = parseJobId(c.req.valid("param").id);
    if (!parsed) return c.json({ error: "not_found" }, 404);
    const { leaseToken, errorCode, errorMessage } = c.req.valid("json");
    const reason = errorMessage ? `${errorCode}: ${errorMessage}` : errorCode;

    if (parsed.kind === KIND_TRANSCRIPTION) {
      const existing = await db.transcription.findUnique({ where: { id: parsed.rowId } });
      if (!existing) return c.json({ error: "not_found" }, 404);
      const isTerminal = existing.attemptCount >= ATTEMPT_CAP;
      const updated = await db.transcription.updateMany({
        where: { id: parsed.rowId, leaseToken },
        data: isTerminal
          ? {
              status: "failed",
              error: reason,
              completedAt: new Date(),
              leaseToken: null,
              leaseExpiresAt: null,
            }
          : { error: reason, leaseToken: null, leaseExpiresAt: null },
      });
      if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
      return c.json({ ok: true, terminal: isTerminal });
    }

    if (parsed.kind === KIND_TRANSLATION) {
      const existing = await db.transcription.findUnique({ where: { id: parsed.rowId } });
      if (!existing) return c.json({ error: "not_found" }, 404);
      const isTerminal = existing.translationAttemptCount >= ATTEMPT_CAP;
      const updated = await db.transcription.updateMany({
        where: { id: parsed.rowId, translationLeaseToken: leaseToken },
        data: isTerminal
          ? {
              translationStatus: "failed",
              translationError: reason,
              translationCompletedAt: new Date(),
              translationLeaseToken: null,
              translationLeaseExpiresAt: null,
            }
          : {
              translationError: reason,
              translationLeaseToken: null,
              translationLeaseExpiresAt: null,
            },
      });
      if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
      return c.json({ ok: true, terminal: isTerminal });
    }

    const existing = await db.moderation.findUnique({ where: { id: parsed.rowId } });
    if (!existing) return c.json({ error: "not_found" }, 404);
    const isTerminal = existing.attemptCount >= ATTEMPT_CAP;
    const updated = await db.moderation.updateMany({
      where: { id: parsed.rowId, leaseToken },
      data: isTerminal
        ? {
            status: "failed",
            error: reason,
            completedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : { error: reason, leaseToken: null, leaseExpiresAt: null },
    });
    if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    // On terminal moderation failure, mirror the in-process pipeline's
    // behavior: surface the message to the operator queue so a human can
    // make the call, and broadcast so live operators see it.
    if (isTerminal) {
      const current = await db.message.findUnique({
        where: { id: existing.messageId },
        select: { status: true },
      });
      if (current?.status === "received") {
        await db.message.update({
          where: { id: existing.messageId },
          data: { status: "pending" },
        });
      }
      await broadcastMessageById(existing.messageId);
    }
    return c.json({ ok: true, terminal: isTerminal });
  },
);

// Re-export internals for tests.
export const __testing = {
  parseJobId,
  jobIdFor,
  ATTEMPT_CAP,
};
