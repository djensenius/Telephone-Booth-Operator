-- Add the booth coarse status emitted when operator-hosted instruction audio is unavailable.
ALTER TYPE "BoothState" ADD VALUE 'callUnavailable' AFTER 'playingInstructions';

-- Instruction audio clips are File-backed and managed by admins.
CREATE TYPE "InstructionStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "Instruction" (
  "id" UUID NOT NULL,
  "description" TEXT,
  "status" "InstructionStatus" NOT NULL DEFAULT 'active',
  "audioId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Instruction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Instruction_audioId_key" ON "Instruction"("audioId");
CREATE INDEX "Instruction_status_createdAt_idx" ON "Instruction"("status", "createdAt");

ALTER TABLE "Instruction"
  ADD CONSTRAINT "Instruction_audioId_fkey"
  FOREIGN KEY ("audioId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
