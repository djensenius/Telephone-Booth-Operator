-- Drop the pull-worker lease bookkeeping. The Transcription app no longer
-- polls `/v1/jobs/*` to lease work; it subscribes to the Operator WebSocket
-- for `work` events and POSTs results back to `/v1/worker/messages/:id/*`
-- (last-writer-wins, no leases). These columns and their indexes are dead.

DROP INDEX IF EXISTS "Transcription_status_leaseExpiresAt_idx";
DROP INDEX IF EXISTS "Transcription_translationStatus_translationLeaseExpiresAt_idx";
DROP INDEX IF EXISTS "Moderation_status_leaseExpiresAt_idx";

ALTER TABLE "Transcription"
    DROP COLUMN IF EXISTS "leaseToken",
    DROP COLUMN IF EXISTS "leaseExpiresAt",
    DROP COLUMN IF EXISTS "leasedAt",
    DROP COLUMN IF EXISTS "attemptCount",
    DROP COLUMN IF EXISTS "translationLeaseToken",
    DROP COLUMN IF EXISTS "translationLeaseExpiresAt",
    DROP COLUMN IF EXISTS "translationLeasedAt",
    DROP COLUMN IF EXISTS "translationAttemptCount";

ALTER TABLE "Moderation"
    DROP COLUMN IF EXISTS "leaseToken",
    DROP COLUMN IF EXISTS "leaseExpiresAt",
    DROP COLUMN IF EXISTS "leasedAt",
    DROP COLUMN IF EXISTS "attemptCount";
