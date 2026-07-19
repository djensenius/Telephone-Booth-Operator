-- Add a capability scope to API tokens so a worker-scoped credential can be
-- issued for the push-worker callback routes without granting the broad
-- booth/operator access that generic tokens carry. Existing tokens keep the
-- historical behaviour by defaulting to "operator".

ALTER TABLE "ApiToken"
    ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'operator';
