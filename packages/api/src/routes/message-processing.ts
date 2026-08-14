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
import type { Prisma } from "../generated/prisma/client.js";
import {
  recordModerationResultInTransaction,
  recordTranscriptionResultInTransaction,
  recordTranslationResultInTransaction,
} from "../lib/ai/pipeline.js";
import { isEnglishLanguage } from "../lib/ai/config.js";
import { recordAudit } from "../lib/audit.js";
import { wsBroadcaster } from "../lib/broadcaster.js";
import { db } from "../lib/db.js";
import { findActiveInstallation, lockInstallationForWrite } from "../lib/installation.js";
import { serializeMessage } from "../lib/serializers.js";
import type { AuthVariables } from "../lib/session.js";

const MAX_ATTEMPTS = 3;
const COMPLETION_LEASE_SECONDS = 900;
const CLAIM_CANDIDATE_LIMIT = 100;

const idParamSchema = z.object({ id: z.guid() });

const messageWithWork = {
  audio: true,
  transcriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
  moderations: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
} satisfies Prisma.MessageInclude;

const findMessageWithWork = (id: string) =>
  db.message.findUnique({ where: { id }, include: messageWithWork });
type HydratedWorkMessage = NonNullable<Awaited<ReturnType<typeof findMessageWithWork>>>;

type WorkMessage = {
  id: string;
  status: string;
  installationId: string | null;
  processingLeaseExpiresAt: Date | null;
  processingLeaseTokenHash: string | null;
  processingLeasedById: string | null;
  processingSnapshotHash: string | null;
  processingFailedAt: Date | null;
  reviewClassification: string | null;
  transcriptions: Array<{
    id: string;
    status: string;
    text: string | null;
    language: string | null;
    translationStatus: string | null;
    translatedText: string | null;
    translatedLanguage: string | null;
  }>;
  moderations: Array<{
    id: string;
    transcriptionId: string | null;
    status: string;
  }>;
};

const leaseHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const newLeaseToken = (): string => randomBytes(32).toString("base64url");

// The lease is tied to the processing-relevant state that the device received.
// Any pipeline or human write changes this hash, so completion can reject the
// stale result while holding the same message row lock as those writers.
const processingSnapshotHash = (message: WorkMessage): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        reviewClassification: message.reviewClassification,
        transcriptions: message.transcriptions.map((transcription) => ({
          id: transcription.id,
          status: transcription.status,
          text: transcription.text,
          language: transcription.language,
          translationStatus: transcription.translationStatus,
          translatedText: transcription.translatedText,
          translatedLanguage: transcription.translatedLanguage,
        })),
        moderations: message.moderations.map((moderation) => ({
          id: moderation.id,
          transcriptionId: moderation.transcriptionId,
          status: moderation.status,
        })),
      }),
      "utf8",
    )
    .digest("hex");

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
    case "stale_snapshot":
      return c.json({ error: "claim_snapshot_stale" }, 409);
    default:
      return c.json({ error: "processing_result_rejected" }, 409);
  }
};

class CompletionRejectedError extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
    this.name = "CompletionRejectedError";
  }
}

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
    let skip = 0;
    for (;;) {
      const candidates = (await db.message.findMany({
        where: {
          installationId: active.id,
          status: { in: ["received", "pending"] },
          processingFailedAt: null,
        },
        include: messageWithWork,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip,
        take: CLAIM_CANDIDATE_LIMIT,
      })) as unknown as WorkMessage[];
      if (candidates.length === 0) return c.json({ claim: null });

      for (const candidate of candidates) {
        const claimed = await db.$transaction(async (tx) => {
          // Take the era's shared lock before the message lock. Close-out takes
          // the era exclusively, so this ordering keeps claims out of an era
          // that is ending and avoids lock-order deadlocks with rollover.
          if (!(await lockInstallationForWrite(tx, active.id))) return null;
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id"
            FROM "Message"
            WHERE "id" = ${candidate.id}::uuid
              AND "installationId" = ${active.id}::uuid
              AND "status" IN ('received', 'pending')
              AND "processingFailedAt" IS NULL
              AND (
                "processingLeaseExpiresAt" IS NULL
                OR "processingLeaseExpiresAt" <= ${now}
              )
            FOR UPDATE SKIP LOCKED
          `;
          if (locked.length === 0) return null;

          const message = await tx.message.findUnique({
            where: { id: candidate.id },
            include: messageWithWork,
          });
          if (!message) return null;
          const current = message as unknown as WorkMessage;
          const needs = processingNeeds(current);
          if (
            needs.length === 0 ||
            activeLease(current, now) ||
            !needs.every((need) => capable.has(need))
          ) {
            return null;
          }

          const token = newLeaseToken();
          const updated = await tx.message.updateMany({
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
              processingSnapshotHash: processingSnapshotHash(current),
              processingAttemptCount: { increment: 1 },
              processingError: null,
            },
          });
          return updated.count === 1 ? { message, needs, token } : null;
        });
        if (!claimed) continue;

        const { message, needs, token } = claimed;
        recordAudit(c, {
          action: "messageProcessing.claim",
          targetType: "message",
          targetId: message.id,
          metadata: { needs, leaseSeconds },
        });
        return c.json({
          claim: {
            message: serializeMessage(message),
            needs,
            leaseToken: token,
            leaseExpiresAt: expiresAt.toISOString(),
            defaultTranscriptionLanguage: active.defaultTranscriptionLanguage,
          },
        });
      }
      skip += candidates.length;
    }
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
        processingSnapshotHash: null,
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
        processingSnapshotHash: null,
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
    const userId = c.get("user").id;
    let completed: { message: HydratedWorkMessage; needs: MessageProcessingStep[] };
    try {
      completed = await db.$transaction(async (tx) => {
        const initial = await tx.message.findUnique({
          where: { id },
          select: { installationId: true },
        });
        if (!initial) throw new CompletionRejectedError("not_found");
        if (
          initial.installationId === null ||
          !(await lockInstallationForWrite(tx, initial.installationId))
        ) {
          throw new CompletionRejectedError("installation_ended");
        }

        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"
          FROM "Message"
          WHERE "id" = ${id}::uuid
            AND "processingLeaseTokenHash" = ${leaseHash(result.leaseToken)}
            AND "processingLeaseExpiresAt" > ${new Date()}
            AND "processingLeasedById" = ${userId}
          FOR UPDATE
        `;
        if (locked.length === 0) throw new CompletionRejectedError("lease_lost");

        const message = await tx.message.findUnique({ where: { id }, include: messageWithWork });
        if (!message) throw new CompletionRejectedError("not_found");
        const current = message as unknown as WorkMessage;
        if (
          current.processingSnapshotHash === null ||
          current.processingSnapshotHash !== processingSnapshotHash(current)
        ) {
          throw new CompletionRejectedError("stale_snapshot");
        }

        await tx.message.update({
          where: { id },
          data: {
            processingLeaseExpiresAt: new Date(Date.now() + COMPLETION_LEASE_SECONDS * 1000),
          },
        });

        let transcriptionId: string | undefined;
        if (result.transcription) {
          const transcription = await recordTranscriptionResultInTransaction(tx, {
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
            throw new CompletionRejectedError(transcription.outcome);
          }
          transcriptionId = transcription.transcriptionId;
          if (result.transcription.text.trim().length > 0) {
            await tx.message.update({
              where: { id },
              data: {
                reviewClassification: null,
                reviewRecommendation: null,
                reviewClassifiedAt: null,
                reviewClassifiedById: null,
              },
            });
          } else {
            await tx.message.updateMany({
              where: { id, status: "received" },
              data: { status: "pending" },
            });
          }
        }

        if (result.translation) {
          const targetTranscriptionId = result.translation.transcriptionId ?? transcriptionId;
          const translation = await recordTranslationResultInTransaction(tx, {
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
            throw new CompletionRejectedError(translation.outcome);
          }
          transcriptionId = translation.transcriptionId;
        }

        if (result.moderation) {
          const target =
            transcriptionId ??
            (
              await tx.transcription.findFirst({
                where: { messageId: id, status: "succeeded" },
                orderBy: { createdAt: "desc" },
              })
            )?.id;
          if (!target) throw new CompletionRejectedError("no_transcription");
          const moderation = await recordModerationResultInTransaction(tx, {
            messageId: id,
            transcriptionId: target,
            ...(result.moderation.inputSha256
              ? { inputSha256: result.moderation.inputSha256 }
              : {}),
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
            throw new CompletionRejectedError(moderation.outcome);
          }
          await tx.message.updateMany({
            where: { id, status: "received" },
            data: { status: "pending" },
          });
        }

        if (result.review) {
          const latest = await tx.transcription.findFirst({
            where: { messageId: id, status: "succeeded" },
            orderBy: { createdAt: "desc" },
          });
          if (!latest || (latest.text ?? "").trim().length > 0) {
            throw new CompletionRejectedError("review_requires_no_speech");
          }
          await tx.message.update({
            where: { id },
            data: {
              reviewClassification: result.review.classification,
              reviewRecommendation: result.review.recommendation,
              reviewClassifiedAt: new Date(),
              reviewClassifiedById: userId,
            },
          });
        }

        const messageAfter = await tx.message.findUnique({
          where: { id },
          include: messageWithWork,
        });
        if (!messageAfter) throw new CompletionRejectedError("not_found");
        const needs = processingNeeds(messageAfter);
        const released = await tx.message.updateMany({
          where: {
            id,
            processingLeaseTokenHash: leaseHash(result.leaseToken),
            processingLeasedById: userId,
          },
          data: {
            processingLeaseTokenHash: null,
            processingLeaseExpiresAt: null,
            processingLeasedAt: null,
            processingLeasedById: null,
            processingSnapshotHash: null,
            processingError: null,
            ...(needs.length === 0 ? { processingCompletedAt: new Date() } : {}),
          },
        });
        if (released.count === 0) throw new CompletionRejectedError("lease_lost");
        return { message: messageAfter, needs };
      });
    } catch (error) {
      if (error instanceof CompletionRejectedError) {
        if (error.outcome === "not_found") return c.json({ error: "not_found" }, 404);
        if (error.outcome === "installation_ended") {
          return c.json({ error: "installation_ended" }, 409);
        }
        if (error.outcome === "lease_lost") return c.json({ error: "lease_lost" }, 409);
        if (error.outcome === "review_requires_no_speech") {
          return c.json({ error: "review_requires_no_speech" }, 409);
        }
        return messageProcessingError(c, error.outcome);
      }
      throw error;
    }

    recordAudit(c, {
      action: "messageProcessing.complete",
      targetType: "message",
      targetId: id,
      metadata: {
        transcription: result.transcription !== undefined,
        translation: result.translation !== undefined,
        moderation: result.moderation !== undefined,
        review: result.review?.classification ?? null,
        remainingNeeds: completed.needs,
      },
    });
    wsBroadcaster.broadcast({ kind: "message", message: serializeMessage(completed.message) });
    return c.json({ message: serializeMessage(completed.message), needs: completed.needs });
  },
);
