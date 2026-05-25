-- Track the local browser session lifetime separately from OIDC access-token expiry.
ALTER TABLE "OperatorSession" ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);

UPDATE "OperatorSession"
SET "accessTokenExpiresAt" = "expiresAt";

CREATE INDEX "OperatorSession_accessTokenExpiresAt_idx" ON "OperatorSession"("accessTokenExpiresAt");
