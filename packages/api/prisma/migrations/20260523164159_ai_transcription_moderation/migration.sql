-- AI transcription + moderation. See docs/transcription-providers.md for the
-- pipeline rationale (auto-trigger on message receive + manual re-runs).

CREATE TYPE "TranscriptionStatus" AS ENUM ('pending', 'succeeded', 'failed');
CREATE TYPE "ModerationRecommendation" AS ENUM ('approve', 'review', 'reject');

CREATE TABLE "Transcription" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "status" "TranscriptionStatus" NOT NULL DEFAULT 'pending',
    "text" TEXT,
    "language" TEXT,
    "durationMs" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Transcription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transcription_messageId_createdAt_idx" ON "Transcription"("messageId", "createdAt");
CREATE INDEX "Transcription_status_createdAt_idx" ON "Transcription"("status", "createdAt");

ALTER TABLE "Transcription"
    ADD CONSTRAINT "Transcription_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transcription"
    ADD CONSTRAINT "Transcription_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "OperatorUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Moderation" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "transcriptionId" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "status" "TranscriptionStatus" NOT NULL DEFAULT 'pending',
    "flagged" BOOLEAN,
    "recommendation" "ModerationRecommendation",
    "maxScore" DOUBLE PRECISION,
    "categories" JSONB,
    "reasonSummary" TEXT,
    "latencyMs" INTEGER,
    "error" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Moderation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Moderation_messageId_createdAt_idx" ON "Moderation"("messageId", "createdAt");
CREATE INDEX "Moderation_recommendation_createdAt_idx" ON "Moderation"("recommendation", "createdAt");

ALTER TABLE "Moderation"
    ADD CONSTRAINT "Moderation_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Moderation"
    ADD CONSTRAINT "Moderation_transcriptionId_fkey"
    FOREIGN KEY ("transcriptionId") REFERENCES "Transcription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Moderation"
    ADD CONSTRAINT "Moderation_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "OperatorUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
