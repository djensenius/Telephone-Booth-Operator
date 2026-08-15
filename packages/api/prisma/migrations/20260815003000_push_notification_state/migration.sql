-- AlterTable
ALTER TABLE "Moderation" ADD COLUMN "pushNotifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PushNotificationState" (
    "key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "threshold" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushNotificationState_pkey" PRIMARY KEY ("key")
);
