-- Collapse repeated booth status heartbeats into a single snapshot row.
-- `firstSeenAt` is the first report of a status, `updatedAt` the newest one,
-- and `repeatCount` how many identical reports were folded in. Existing rows
-- each represent exactly one report, so they backfill to firstSeenAt =
-- updatedAt and repeatCount = 1.
ALTER TABLE "BoothStatusSnapshot"
  ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "repeatCount" INTEGER NOT NULL DEFAULT 1;

UPDATE "BoothStatusSnapshot" SET "firstSeenAt" = "updatedAt";

-- Every heartbeat resolves the run enclosing its own timestamp, so index the
-- lookup rather than scanning a long pre-collapse heartbeat history.
CREATE INDEX "BoothStatusSnapshot_firstSeenAt_id_idx"
  ON "BoothStatusSnapshot" ("firstSeenAt", "id");
