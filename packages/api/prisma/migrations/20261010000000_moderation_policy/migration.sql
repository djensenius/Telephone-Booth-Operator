CREATE TABLE "ModerationPolicy" (
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "instructions" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ModerationPolicy_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "ModerationPolicy"
ADD CONSTRAINT "ModerationPolicy_updatedById_fkey"
FOREIGN KEY ("updatedById") REFERENCES "OperatorUser"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
