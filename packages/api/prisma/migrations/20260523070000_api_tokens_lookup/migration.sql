-- Add lookup IDs and align API token ownership/name columns with the phone-client token contract.
ALTER TABLE "ApiToken" DROP CONSTRAINT IF EXISTS "ApiToken_createdById_fkey";

ALTER TABLE "ApiToken" RENAME COLUMN "label" TO "name";
ALTER TABLE "ApiToken" RENAME COLUMN "createdById" TO "createdByUserId";

ALTER TABLE "ApiToken" ADD COLUMN "lookupId" TEXT;
UPDATE "ApiToken" SET "lookupId" = 'legacy_' || "id"::text WHERE "lookupId" IS NULL;
ALTER TABLE "ApiToken" ALTER COLUMN "lookupId" SET NOT NULL;

CREATE UNIQUE INDEX "ApiToken_lookupId_key" ON "ApiToken"("lookupId");
CREATE INDEX "ApiToken_lookupId_idx" ON "ApiToken"("lookupId");
CREATE INDEX "ApiToken_createdByUserId_createdAt_idx" ON "ApiToken"("createdByUserId", "createdAt");

ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "OperatorUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
