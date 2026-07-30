-- Installations: a named era of the booth. Time-series data is tagged with
-- `installationId` so ending an installation is a scope change rather than a
-- delete, and past runs stay browsable live.
--
-- `installationId` is nullable in the column so this migration never rewrites
-- a large existing table; the API always populates it at write time via
-- `requireActiveInstallation()`. The backfill below assigns every pre-existing
-- row to a seeded initial installation.

-- CreateTable
CREATE TABLE "Installation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "location" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Installation_startedAt_idx" ON "Installation"("startedAt");

-- CreateIndex
CREATE INDEX "Installation_endedAt_idx" ON "Installation"("endedAt");

-- At most one installation may be active (open) at a time. A partial unique
-- index on a constant expression is the standard Postgres "singleton row"
-- trick and makes the invariant unbreakable from any code path.
CREATE UNIQUE INDEX "Installation_single_active_idx"
    ON "Installation" ((1)) WHERE "endedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "OperatorUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN "installationId" UUID;
ALTER TABLE "Message" ADD COLUMN "installationId" UUID;
ALTER TABLE "CallSession" ADD COLUMN "installationId" UUID;
ALTER TABLE "BoothEvent" ADD COLUMN "installationId" UUID;
ALTER TABLE "BoothStatusSnapshot" ADD COLUMN "installationId" UUID;

-- Backfill: seed the initial installation and adopt all existing data into it.
-- `startedAt` is pulled back to the oldest known activity so the first era's
-- date range reflects reality rather than the deploy time of this migration.
INSERT INTO "Installation" ("id", "name", "notes", "startedAt", "createdAt")
VALUES (
    gen_random_uuid(),
    'Installation 1',
    'Created automatically when installation scoping was introduced. Contains all data recorded before that point.',
    COALESCE(
        LEAST(
            (SELECT MIN("createdAt") FROM "Message"),
            (SELECT MIN("startedAt") FROM "CallSession"),
            (SELECT MIN("occurredAt") FROM "BoothEvent"),
            (SELECT MIN("createdAt") FROM "Question")
        ),
        CURRENT_TIMESTAMP
    ),
    CURRENT_TIMESTAMP
);

UPDATE "Question" SET "installationId" = (SELECT "id" FROM "Installation" LIMIT 1);
UPDATE "Message" SET "installationId" = (SELECT "id" FROM "Installation" LIMIT 1);
UPDATE "CallSession" SET "installationId" = (SELECT "id" FROM "Installation" LIMIT 1);
UPDATE "BoothEvent" SET "installationId" = (SELECT "id" FROM "Installation" LIMIT 1);
UPDATE "BoothStatusSnapshot" SET "installationId" = (SELECT "id" FROM "Installation" LIMIT 1);

-- CreateIndex
CREATE INDEX "Question_installationId_status_createdAt_idx" ON "Question"("installationId", "status", "createdAt");
CREATE INDEX "Message_installationId_status_createdAt_idx" ON "Message"("installationId", "status", "createdAt");
CREATE INDEX "CallSession_installationId_startedAt_idx" ON "CallSession"("installationId", "startedAt");
CREATE INDEX "BoothEvent_installationId_occurredAt_idx" ON "BoothEvent"("installationId", "occurredAt");
CREATE INDEX "BoothStatusSnapshot_installationId_updatedAt_idx" ON "BoothStatusSnapshot"("installationId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BoothEvent" ADD CONSTRAINT "BoothEvent_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BoothStatusSnapshot" ADD CONSTRAINT "BoothStatusSnapshot_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Questions can now share a File row across installations. Copying a question
-- forward into a new era reuses the same audio blob instead of cloning the
-- File, so `audioId` can no longer be globally unique.
DROP INDEX "Question_audioId_key";
CREATE INDEX "Question_audioId_idx" ON "Question"("audioId");

-- Prompts are unique within an installation rather than globally, so the same
-- question can run in more than one era.
DROP INDEX "Question_prompt_key";
CREATE UNIQUE INDEX "Question_installationId_prompt_key" ON "Question"("installationId", "prompt");
