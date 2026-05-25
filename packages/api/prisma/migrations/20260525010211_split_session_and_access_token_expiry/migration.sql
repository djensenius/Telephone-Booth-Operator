-- Track the local browser session lifetime separately from OIDC access-token expiry.
ALTER TABLE "OperatorSession" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);

UPDATE "OperatorSession"
SET "accessTokenExpiresAt" = "expiresAt";

UPDATE "OperatorSession"
SET "expiresAt" = GREATEST("createdAt" + INTERVAL '12 hours', CURRENT_TIMESTAMP + INTERVAL '12 hours')
WHERE "expiresAt" > CURRENT_TIMESTAMP;

CREATE INDEX "OperatorSession_accessTokenExpiresAt_idx" ON "OperatorSession"("accessTokenExpiresAt");
