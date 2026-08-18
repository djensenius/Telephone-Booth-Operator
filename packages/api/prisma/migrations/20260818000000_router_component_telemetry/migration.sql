-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN     "telemetrySourceId" UUID;

-- CreateTable
CREATE TABLE "TelemetrySource" (
    "id" UUID NOT NULL,
    "boothId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prometheusJob" TEXT NOT NULL,
    "prometheusInstance" TEXT NOT NULL,
    "latestSnapshot" JSONB,
    "capturedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetrySource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetrySource_boothId_idx" ON "TelemetrySource"("boothId");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetrySource_boothId_componentId_key" ON "TelemetrySource"("boothId", "componentId");

-- CreateIndex
CREATE INDEX "ApiToken_telemetrySourceId_idx" ON "ApiToken"("telemetrySourceId");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_telemetrySourceId_fkey" FOREIGN KEY ("telemetrySourceId") REFERENCES "TelemetrySource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
