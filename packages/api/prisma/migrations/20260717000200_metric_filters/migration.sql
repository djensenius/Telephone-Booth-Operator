-- CreateTable
CREATE TABLE "MetricFilter" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "window" TEXT,
    "rangeStart" TIMESTAMP(3),
    "rangeEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricFilter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricFilter_userId_idx" ON "MetricFilter"("userId");

-- AddForeignKey
ALTER TABLE "MetricFilter" ADD CONSTRAINT "MetricFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OperatorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
