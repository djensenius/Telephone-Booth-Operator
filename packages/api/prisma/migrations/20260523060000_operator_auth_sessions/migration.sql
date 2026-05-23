-- Extend operator users with provider-agnostic OIDC profile fields.
ALTER TABLE "OperatorUser" ADD COLUMN "oidcSub" TEXT;
UPDATE "OperatorUser" SET "oidcSub" = "id" WHERE "oidcSub" IS NULL;
ALTER TABLE "OperatorUser" ALTER COLUMN "oidcSub" SET NOT NULL;
ALTER TABLE "OperatorUser" ADD COLUMN "picture" TEXT;
ALTER TABLE "OperatorUser" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "OperatorUser" ALTER COLUMN "groups" TYPE JSONB USING to_jsonb("groups");
ALTER TABLE "OperatorUser" ALTER COLUMN "groups" DROP NOT NULL;

CREATE UNIQUE INDEX "OperatorUser_oidcSub_key" ON "OperatorUser"("oidcSub");

-- Persist browser sessions as opaque cookie IDs with encrypted refresh tokens.
CREATE TABLE "OperatorSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idToken" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorSession_userId_idx" ON "OperatorSession"("userId");
CREATE INDEX "OperatorSession_expiresAt_idx" ON "OperatorSession"("expiresAt");

ALTER TABLE "OperatorSession" ADD CONSTRAINT "OperatorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OperatorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
