-- CreateTable
CREATE TABLE "BoothSystemSnapshot" (
    "boothId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "version" TEXT,

    CONSTRAINT "BoothSystemSnapshot_pkey" PRIMARY KEY ("boothId")
);
