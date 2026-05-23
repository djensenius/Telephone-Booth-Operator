-- Add upload lifecycle states for direct-to-blob message ingestion.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'uploading' BEFORE 'pending';
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'received' AFTER 'uploading';

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
