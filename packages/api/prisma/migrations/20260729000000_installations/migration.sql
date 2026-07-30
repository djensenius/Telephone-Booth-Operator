-- Installations: a named era of the booth. Time-series data is tagged with
-- `installationId` so ending an installation is a scope change rather than a
-- delete, and past runs stay browsable live.
--
-- `installationId` is nullable in the column so adding it is a metadata-only
-- change rather than a table rewrite, and so the backfill can run at all. The
-- API always populates it at write time via `requireActiveInstallation()`.
-- The backfill below does write every pre-existing row, which on a large table
-- takes a row-exclusive lock and produces WAL proportional to the table size.
-- Run it during a quiet window, or split it into batches, if these tables have
-- grown large.

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
            (SELECT MIN("createdAt") FROM "Question"),
            (SELECT MIN("firstSeenAt") FROM "BoothStatusSnapshot")
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
-- The events list scopes by installation but orders and paginates by
-- (receivedAt, id), and the console polls it every ten seconds.
CREATE INDEX "BoothEvent_installationId_receivedAt_id_idx" ON "BoothEvent"("installationId", "receivedAt", "id");
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
-- Uniqueness is kept per era instead: sharing a File is for copying a question
-- forward, not for two prompts in one era playing the same recording.
CREATE UNIQUE INDEX "Question_installationId_audioId_key" ON "Question"("installationId", "audioId");

-- Prompts are unique within an installation rather than globally, so the same
-- question can run in more than one era.
DROP INDEX "Question_prompt_key";
CREATE UNIQUE INDEX "Question_installationId_prompt_key" ON "Question"("installationId", "prompt");

-- The migration runs before the new API rolls out, and the previous revision
-- knows nothing about installations: every row it writes in the meantime would
-- land with a NULL era and then vanish from the new default-scoped reads. A
-- trigger stamps those rows with whichever era is open, so a rollout needs no
-- second backfill and no write is lost in the window. It stays afterwards as a
-- backstop: the application always supplies the column, and when it does the
-- trigger does nothing.
CREATE OR REPLACE FUNCTION "installation_default_scope"() RETURNS trigger AS $$
DECLARE
    era uuid;
BEGIN
    IF NEW."installationId" IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT "id" INTO era FROM "Installation" WHERE "endedAt" IS NULL
        ORDER BY "startedAt" DESC LIMIT 1;

    -- A new-revision replica can end the only open era while an old one is
    -- still writing, so "none open" is reachable during a rollout. Open one
    -- the same way the API does rather than let the row fall outside every
    -- scoped read. ON CONFLICT covers the partial unique index that allows
    -- only one open era: the loser re-reads the winner's row.
    IF era IS NULL THEN
        INSERT INTO "Installation" ("id", "name", "notes", "startedAt", "createdAt")
        VALUES (
            gen_random_uuid(),
            'Installation ' || ((SELECT COUNT(*) FROM "Installation") + 1)::text,
            'Opened automatically for a write that arrived with no installation active.',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT DO NOTHING
        RETURNING "id" INTO era;

        IF era IS NULL THEN
            SELECT "id" INTO era FROM "Installation" WHERE "endedAt" IS NULL
                ORDER BY "startedAt" DESC LIMIT 1;
        END IF;
    END IF;

    NEW."installationId" := era;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Question_installation_default" BEFORE INSERT ON "Question"
    FOR EACH ROW EXECUTE FUNCTION "installation_default_scope"();
CREATE TRIGGER "Message_installation_default" BEFORE INSERT ON "Message"
    FOR EACH ROW EXECUTE FUNCTION "installation_default_scope"();
CREATE TRIGGER "CallSession_installation_default" BEFORE INSERT ON "CallSession"
    FOR EACH ROW EXECUTE FUNCTION "installation_default_scope"();
CREATE TRIGGER "BoothEvent_installation_default" BEFORE INSERT ON "BoothEvent"
    FOR EACH ROW EXECUTE FUNCTION "installation_default_scope"();
CREATE TRIGGER "BoothStatusSnapshot_installation_default" BEFORE INSERT ON "BoothStatusSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "installation_default_scope"();
