-- CreateTable
CREATE TABLE "MobileDevice" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "apnsToken" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceName" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MobileDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobileDevice_apnsToken_platform_key" ON "MobileDevice"("apnsToken", "platform");

-- CreateIndex
CREATE INDEX "MobileDevice_userId_revokedAt_idx" ON "MobileDevice"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OperatorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
