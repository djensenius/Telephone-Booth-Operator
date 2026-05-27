-- Translation result columns on Transcription (one row per attempt; translation
-- lives on the same row as the transcription it derives from so the operator
-- UI has a single source of truth per attempt). Plus lease columns on both
-- Transcription and Moderation so the pull-worker model can claim pending
-- work atomically.

ALTER TABLE "Transcription"
    ADD COLUMN "translationStatus"        "TranscriptionStatus",
    ADD COLUMN "translatedText"           TEXT,
    ADD COLUMN "translatedLanguage"       TEXT,
    ADD COLUMN "translationProvider"      TEXT,
    ADD COLUMN "translationModel"         TEXT,
    ADD COLUMN "translationError"         TEXT,
    ADD COLUMN "translationLatencyMs"     INTEGER,
    ADD COLUMN "translationCompletedAt"   TIMESTAMP(3),
    ADD COLUMN "leaseToken"               TEXT,
    ADD COLUMN "leaseExpiresAt"           TIMESTAMP(3),
    ADD COLUMN "leasedAt"                 TIMESTAMP(3),
    ADD COLUMN "attemptCount"             INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "translationLeaseToken"    TEXT,
    ADD COLUMN "translationLeaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "translationLeasedAt"      TIMESTAMP(3),
    ADD COLUMN "translationAttemptCount"  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Transcription_status_leaseExpiresAt_idx"
    ON "Transcription"("status", "leaseExpiresAt");
CREATE INDEX "Transcription_translationStatus_translationLeaseExpiresAt_idx"
    ON "Transcription"("translationStatus", "translationLeaseExpiresAt");

ALTER TABLE "Moderation"
    ADD COLUMN "leaseToken"     TEXT,
    ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "leasedAt"       TIMESTAMP(3),
    ADD COLUMN "attemptCount"   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Moderation_status_leaseExpiresAt_idx"
    ON "Moderation"("status", "leaseExpiresAt");
