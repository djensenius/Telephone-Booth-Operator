-- Give questions a publication lifecycle: draft -> active -> archived.
-- "active" is what the booth's /v1/questions/random endpoint now serves.
CREATE TYPE "QuestionStatus" AS ENUM ('draft', 'active', 'archived');

ALTER TABLE "Question"
  ADD COLUMN "status" "QuestionStatus" NOT NULL DEFAULT 'draft';

-- Backfill existing rows from the previous retiredAt-only model: anything
-- already retired becomes archived, everything else was being served, so it
-- is active.
UPDATE "Question" SET "status" = 'archived' WHERE "retiredAt" IS NOT NULL;
UPDATE "Question" SET "status" = 'active' WHERE "retiredAt" IS NULL;

CREATE INDEX "Question_status_createdAt_idx" ON "Question" ("status", "createdAt");
