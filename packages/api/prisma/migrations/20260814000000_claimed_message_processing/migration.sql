-- Operator-authenticated, message-level on-device processing leases.
-- The token digest is stored on Message so a lease covers its complete local
-- result set (transcription, translation, moderation, or no-speech review).

CREATE TYPE "MessageReviewClassification" AS ENUM ('likely_hangup', 'unclear');
CREATE TYPE "MessageReviewRecommendation" AS ENUM ('delete', 'review');

ALTER TABLE "Installation"
    ADD COLUMN "defaultTranscriptionLanguage" TEXT;

ALTER TABLE "Message"
    ADD COLUMN "reviewClassification" "MessageReviewClassification",
    ADD COLUMN "reviewRecommendation" "MessageReviewRecommendation",
    ADD COLUMN "reviewClassifiedAt" TIMESTAMP(3),
    ADD COLUMN "reviewClassifiedById" TEXT,
    ADD COLUMN "processingLeaseTokenHash" TEXT,
    ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "processingLeasedAt" TIMESTAMP(3),
    ADD COLUMN "processingLeasedById" TEXT,
    ADD COLUMN "processingSnapshotHash" TEXT,
    ADD COLUMN "processingAttemptCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "processingError" TEXT,
    ADD COLUMN "processingFailedAt" TIMESTAMP(3),
    ADD COLUMN "processingCompletedAt" TIMESTAMP(3);

ALTER TABLE "Message"
    ADD CONSTRAINT "Message_reviewClassifiedById_fkey"
    FOREIGN KEY ("reviewClassifiedById") REFERENCES "OperatorUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Message"
    ADD CONSTRAINT "Message_processingLeasedById_fkey"
    FOREIGN KEY ("processingLeasedById") REFERENCES "OperatorUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Message_installationId_status_processingLeaseExpiresAt_createdAt_idx"
    ON "Message"("installationId", "status", "processingLeaseExpiresAt", "createdAt");
