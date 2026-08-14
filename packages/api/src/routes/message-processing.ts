// OIDC-authenticated, on-device message-processing queue.
//
// A lease belongs to the Message rather than individual transcription /
// translation / moderation rows: one device receives all hydrated context for
// one recording and is the only device allowed to submit its local result set
// until its short lease expires.

import { zValidator } from "@hono/zod-validator";
import {
  MessageProcessingClaimRequestSchema,
  MessageProcessingCompleteSchema,
  MessageProcessingFailSchema,
  MessageProcessingHeartbeatSchema,
  MessageProcessingLeaseTokenSchema,
  type MessageProcessingStep,
} from "@telephone-booth-operator/shared";
import { Hono, type Context } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  recordModerationResult,
  recordTranscriptionResult,
  recordTranslationResult,
} from "../lib/ai/pipeline.js";
import { isEnglishLanguage } from "../lib/ai/config.js";
import { recordAudit } from "../lib/audit.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { findActiveInstallation } from "../lib/installation.js";
import { serializeMessage } from "../lib/serializers.js";
import type { AuthVariables } from "../lib/session.js";

const MAX_ATTEMPTS = 3;
const COMPLETION_LEASE_SECONDS = 900;
const CLAIM_CANDIDATE_LIMIT = 100;

const idParamSchema = z.object({ id: z.guid() });

const messageWithWork = {
  audio: true,
  transcriptions: { orderBy: { createdAt: "desc" } },
  moderations: { orderBy: { createdAt: "desc" } },
} as const;

type WorkMessage = {
  id: string;
  status: string;
  installationId: string | null;
  processingLeaseExpiresAt: Date | null;
  processingFailedAt: Date | null;
  reviewClassification: string | null;
  transcriptions: Array<{
    id: string;
    status: string;
    text: string | null;
    language: string | null;
    translationStatus: string | null;
  }>;
  moderations: Array<{
    transcriptionId: string | null;
    status: string;
  }>;
};

const leaseHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const newLeaseToken = (): string => randomBytes(32).toString("base64url");

const latestSucceededTranscription = (message: WorkMessage) =>
  message.transcriptions.find((row) => row.status === "succeeded") ?? null;

const processingNeeds = (message: WorkMessage): MessageProcessingStep[] => {
  const transcription = latestSucceededTranscription(message);
  if (!transcription) return ["transcription"];
  if ((transcription.text ?? "").trim().length === 0) {
    return message.reviewClassification === null ? ["review"] : [];
  }

  const needs: MessageProcessingStep[] = [];
  if (
    transcription.translationStatus !== "succeeded" &&
    !isEnglishLanguage(transcription.language)
  ) {
    needs.push("translation");
  }
  const hasCurrentModeration = message.moderations.some(
    (row) => row.transcriptionId === transcription.id && row.status === "succeeded",
  );
  if (!hasCurrentModeration) needs.push("moderation");
  return needs;
};

const activeLease = (message: WorkMessage, now: Date): boolean =>
  message.processingLeaseExpiresAt !== null && message.processingLeaseExpiresAt > now;

const summaryForCurrentInstallation = async () => {
  const active = await findActiveInstallation();
  const empty = {
    queued: 0,
    leased: 0,
    terminal: 0,
    needs: { transcription: 0, translation: 0, moderation: 0, review: 0 },
    generatedAt: new Date().toISOString(),
  };
  if (!active) return empty;

  const now = new Date();
  const rows = (await db.message.findMany({
    where: {
      installationId: active.id,
      status: { in: ["received", "pending"] },
    },
    include: messageWithWork,
  })) as unknown as WorkMessage[];
  for (const row of rows) {
    const needs = processingNeeds(row);
    if (needs.length === 0) continue;
    for (const need of needs) empty.needs[need] += 1;
    if (row.processingFailedAt !== null) {
      empty.terminal += 1;
      continue;
    }
    if (activeLease(row, now)) empty.leased += 1;
    else empty.queued += 1;
  }
  return empty;
};

const messageProcessingError = (c: Context<{ Variables: AuthVariables }>, outcome: string) => {
  switch (outcome) {
    case "not_found":
      return c.json({ error: "not_found" }, 404);
    case "no_transcription":
      return c.json({ error: "no_succeeded_transcription" }, 409);
    case "stale_transcription":
      return c.json({ error: "stale_transcription" }, 409);
    case "stale_translation":
      return c.json({ error: "stale_translation" }, 409);
    case "transcription_not_found":
      return c.json({ error: "transcription_not_found" }, 404);
    case "stale_input":
      return c.json({ error: "stale_moderation_input" }, 409);
    default:
      return c.json({ error: "processing_result_rejected" }, 409);
  }
};

export const messageProcessingRouter = new Hono<{ Variables: AuthVariables }>();

messageProcessingRouter.get("/summary", async (c) => c.json(await summaryForCurrentInstallation()));

messageProcessingRouter.post(
  "/claim",
  zValidator("json", MessageProcessingClaimRequestSchema),
  async (c) => {
    const { capabilities, leaseSeconds } = c.req.valid("json");
    const active = await findActiveInstallation();
    if (!active) return c.json({ claim: null });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const capable = new Set(capabilities);
    const candidates = (await db.message.findMany({
      where: {
        installationId: active.id,
        status: { in: ["received", "pending"] },
        processingFailedAt: null,
      },
      include: messageWithWork,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CLAIM_CANDIDATE_LIMIT,
    })) as unknown as WorkMessage[];

    for (const candidate of candidates) {
      const needs = processingNeeds(candidate);
      if (
        needs.length === 0 ||
        !needs.every((need) => capable.has(need)) ||
        activeLease(candidate, now)
      ) {
        continue;
      }

      const token = newLeaseToken();
      const updated = await db.message.updateMany({
        where: {
          id: candidate.id,
          installationId: active.id,
          status: { in: ["received", "pending"] },
          processingFailedAt: null,
          OR: [{ processingLeaseExpiresAt: null }, { processingLeaseExpiresAt: { lte: now } }],
        },
        data: {
          processingLeaseTokenHash: leaseHash(token),
          processingLeaseExpiresAt: expiresAt,
          processingLeasedAt: now,
          processingLeasedById: c.get("user").id,
          processingAttemptCount: { increment: 1 },
          processingError: null,
        },
      });
      if (updated.count === 0) continue;

      const message = await db.message.findUnique({
        where: { id: candidate.id },
        include: messageWithWork,
      });
      if (!message) continue;
      const actualNeeds = processingNeeds(message);
      if (actualNeeds.length === 0 || !actualNeeds.every((need) => capable.has(need))) {
        await db.message.updateMany({
          where: {
            id: message.id,
            processingLeaseTokenHash: leaseHash(token),
          },
          data: {
            processingLeaseTokenHash: null,
            processingLeaseExpiresAt: null,
            processingLeasedAt: null,
            processingLeasedById: null,
          },
        });
        continue;
      }
      recordAudit(c, {
        action: "messageProcessing.claim",
        targetType: "message",
        targetId: message.id,
        metadata: { needs: actualNeeds, leaseSeconds },
      });
      return c.json({
        claim: {
          message: serializeMessage(message),
          needs: actualNeeds,
          leaseToken: token,
          leaseExpiresAt: expiresAt.toISOString(),
          defaultTranscriptionLanguage: active.defaultTranscriptionLanguage,
        },
      });
    }
    return c.json({ claim: null });
  },
);

const renewLease = async (
  messageId: string,
  token: string,
  seconds: number,
  userId: string,
): Promise<"lease_lost" | "installation_ended" | Date> => {
  const active = await findActiveInstallation();
  const existing = await db.message.findUnique({
    where: { id: messageId },
    select: { installationId: true },
  });
  if (!existing) return "lease_lost";
  if (!active || existing.installationId !== active.id) return "installation_ended";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + seconds * 1000);
  const updated = await db.message.updateMany({
    where: {
      id: messageId,
      installationId: active.id,
      processingLeaseTokenHash: leaseHash(token),
      processingLeaseExpiresAt: { gt: now },
      processingLeasedById: userId,
    },
    data: { processingLeaseExpiresAt: expiresAt },
  });
  return updated.count === 1 ? expiresAt : "lease_lost";
};

messageProcessingRouter.post(
  "/:id/heartbeat",
  zValidator("param", idParamSchema),
  zValidator("json", MessageProcessingHeartbeatSchema),
  async (c) => {
    const { leaseToken, leaseSeconds } = c.req.valid("json");
    const result = await renewLease(
      c.req.valid("param").id,
      leaseToken,
      leaseSeconds,
      c.get("user").id,
    );
    if (result === "installation_ended") return c.json({ error: result }, 409);
    if (result === "lease_lost") return c.json({ error: result }, 409);
    return c.json({ ok: true, leaseExpiresAt: result.toISOString() });
  },
);

messageProcessingRouter.post(
  "/:id/release",
  zValidator("param", idParamSchema),
  zValidator("json", MessageProcessingLeaseTokenSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { leaseToken } = c.req.valid("json");
    const now = new Date();
    const updated = await db.message.updateMany({
      where: {
        id,
        processingLeaseTokenHash: leaseHash(leaseToken),
        processingLeaseExpiresAt: { gt: now },
        processingLeasedById: c.get("user").id,
      },
      data: {
        processingLeaseTokenHash: null,
        processingLeaseExpiresAt: null,
        processingLeasedAt: null,
        processingLeasedById: null,
      },
    });
    if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    recordAudit(c, {
      action: "messageProcessing.release",
      targetType: "message",
      targetId: id,
    });
    return c.body(null, 204);
  },
);

messageProcessingRouter.post(
  "/:id/fail",
  zValidator("param", idParamSchema),
  zValidator("json", MessageProcessingFailSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { leaseToken, errorCode, errorMessage } = c.req.valid("json");
    const existing = await db.message.findUnique({
      where: { id },
      select: { processingAttemptCount: true },
    });
    if (!existing) return c.json({ error: "not_found" }, 404);
    const terminal = existing.processingAttemptCount >= MAX_ATTEMPTS;
    const updated = await db.message.updateMany({
      where: {
        id,
        processingLeaseTokenHash: leaseHash(leaseToken),
        processingLeaseExpiresAt: { gt: new Date() },
        processingLeasedById: c.get("user").id,
      },
      data: {
        processingLeaseTokenHash: null,
        processingLeaseExpiresAt: null,
        processingLeasedAt: null,
        processingLeasedById: null,
        processingError: errorMessage ? `${errorCode}: ${errorMessage}` : errorCode,
        ...(terminal ? { processingFailedAt: new Date() } : {}),
      },
    });
    if (updated.count === 0) return c.json({ error: "lease_lost" }, 409);
    recordAudit(c, {
      action: "messageProcessing.fail",
      targetType: "message",
      targetId: id,
      metadata: { errorCode, terminal },
    });
    return c.json({ ok: true, terminal });
  },
);

messageProcessingRouter.post(
  "/:id/complete",
  zValidator("param", idParamSchema),
  zValidator("json", MessageProcessingCompleteSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = c.req.valid("json");
    const renewed = await renewLease(
      id,
      result.leaseToken,
      COMPLETION_LEASE_SECONDS,
      c.get("user").id,
    );
    if (renewed === "installation_ended") return c.json({ error: renewed }, 409);
    if (renewed === "lease_lost") return c.json({ error: renewed }, 409);

    const userId = c.get("user").id;
    let transcriptionId: string | undefined;
    if (result.transcription) {
      const transcription = await recordTranscriptionResult({
        messageId: id,
        ...("expectedLatestTranscriptionId" in result.transcription
          ? {
              expectedLatestTranscriptionId:
                result.transcription.expectedLatestTranscriptionId ?? null,
            }
          : {}),
        ...("expectedLatestTranscriptionSha256" in result.transcription
          ? {
              expectedLatestTranscriptionSha256:
                result.transcription.expectedLatestTranscriptionSha256 ?? null,
            }
          : {}),
        text: result.transcription.text,
        language: result.transcription.language ?? null,
        model: result.transcription.model ?? null,
        provider: "on_device",
        processDownstream: false,
        requestedByUserId: userId,
      });
      if (
        transcription.outcome === "not_found" ||
        transcription.outcome === "stale_transcription"
      ) {
        return messageProcessingError(c, transcription.outcome);
      }
      transcriptionId = transcription.transcriptionId;
      if (result.transcription.text.trim().length > 0) {
        await db.message.update({
          where: { id },
          data: {
            reviewClassification: null,
            reviewRecommendation: null,
            reviewClassifiedAt: null,
            reviewClassifiedById: null,
          },
        });
      }
    }

    if (result.translation) {
      const targetTranscriptionId = result.translation.transcriptionId ?? transcriptionId;
      const translation = await recordTranslationResult({
        messageId: id,
        ...(targetTranscriptionId ? { transcriptionId: targetTranscriptionId } : {}),
        ...("expectedTranslationSha256" in result.translation
          ? { expectedTranslationSha256: result.translation.expectedTranslationSha256 ?? null }
          : {}),
        translatedText: result.translation.translatedText,
        translatedLanguage: result.translation.translatedLanguage ?? null,
        model: result.translation.model ?? null,
        provider: "on_device",
      });
      if (translation.outcome !== "recorded") {
        return messageProcessingError(c, translation.outcome);
      }
      transcriptionId = translation.transcriptionId;
    }

    if (result.moderation) {
      const target =
        transcriptionId ??
        (
          await db.transcription.findFirst({
            where: { messageId: id, status: "succeeded" },
            orderBy: { createdAt: "desc" },
          })
        )?.id;
      if (!target) return c.json({ error: "no_succeeded_transcription" }, 409);
      const moderation = await recordModerationResult({
        messageId: id,
        transcriptionId: target,
        ...(result.moderation.inputSha256 ? { inputSha256: result.moderation.inputSha256 } : {}),
        flagged: result.moderation.flagged,
        recommendation: result.moderation.recommendation,
        maxScore: result.moderation.maxScore,
        categories: result.moderation.categories ?? null,
        reasonSummary: result.moderation.reasonSummary ?? null,
        model: result.moderation.model ?? null,
        provider: "on_device",
        requestedByUserId: userId,
        createWhenMissing: true,
      });
      if (moderation.outcome !== "recorded" && moderation.outcome !== "unchanged") {
        return messageProcessingError(c, moderation.outcome);
      }
    }

    if (result.review) {
      const latest = await db.transcription.findFirst({
        where: { messageId: id, status: "succeeded" },
        orderBy: { createdAt: "desc" },
      });
      if (!latest || (latest.text ?? "").trim().length > 0) {
        return c.json({ error: "review_requires_no_speech" }, 409);
      }
      const reviewed = await db.message.updateMany({
        where: {
          id,
          processingLeaseTokenHash: leaseHash(result.leaseToken),
          processingLeaseExpiresAt: { gt: new Date() },
          processingLeasedById: userId,
        },
        data: {
          reviewClassification: result.review.classification,
          reviewRecommendation: result.review.recommendation,
          reviewClassifiedAt: new Date(),
          reviewClassifiedById: userId,
        },
      });
      if (reviewed.count === 0) return c.json({ error: "lease_lost" }, 409);
    }

    const message = await db.message.findUnique({ where: { id }, include: messageWithWork });
    if (!message) return c.json({ error: "not_found" }, 404);
    const needs = processingNeeds(message);
    const released = await db.message.updateMany({
      where: {
        id,
        processingLeaseTokenHash: leaseHash(result.leaseToken),
        processingLeaseExpiresAt: { gt: new Date() },
        processingLeasedById: userId,
      },
      data: {
        processingLeaseTokenHash: null,
        processingLeaseExpiresAt: null,
        processingLeasedAt: null,
        processingLeasedById: null,
        processingError: null,
        ...(needs.length === 0 ? { processingCompletedAt: new Date() } : {}),
      },
    });
    if (released.count === 0) return c.json({ error: "lease_lost" }, 409);
    recordAudit(c, {
      action: "messageProcessing.complete",
      targetType: "message",
      targetId: id,
      metadata: {
        transcription: result.transcription !== undefined,
        translation: result.translation !== undefined,
        moderation: result.moderation !== undefined,
        review: result.review?.classification ?? null,
        remainingNeeds: needs,
      },
    });
    const hydrated = await db.message.findUnique({ where: { id }, include: messageWithWork });
    if (hydrated) wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(hydrated) });
    return c.json({ message: serializeMessage(hydrated ?? message), needs });
  },
);
