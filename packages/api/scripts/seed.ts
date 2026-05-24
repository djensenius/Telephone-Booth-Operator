/**
 * Seed script — idempotent. Populates sample questions and placeholder
 * audio File rows so a fresh install has useful content to work with.
 *
 * Re-run with `just db-seed` or
 * `pnpm --filter @telephone-booth-operator/api exec tsx scripts/seed.ts`.
 */
import { createHash } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BLOB_CONTAINER = process.env.AZURE_BLOB_CONTAINER ?? "booth-recordings";
const CONTENT_TYPE = "audio/flac";

const SAMPLE_QUESTIONS = [
  "What's a moment from the last year you'd like to remember?",
  "What's something you've never told anyone?",
  "Describe the room you grew up in.",
  "What would you say to your 15-year-old self?",
  "What's the kindest thing a stranger ever did for you?",
  "Who taught you something you still use today?",
  "What sound instantly takes you back to childhood?",
  "Tell a story about a place that feels like home.",
];

function placeholderSha256(blobKey: string): string {
  return createHash("sha256").update(`telephone-booth-operator:${blobKey}`).digest("hex");
}

async function upsertPlaceholderFile(blobKey: string, sizeBytes: number, durationMs?: number) {
  return prisma.file.upsert({
    where: { blobKey },
    update: {
      blobContainer: BLOB_CONTAINER,
      sha256: placeholderSha256(blobKey),
      sizeBytes,
      durationMs,
      contentType: CONTENT_TYPE,
    },
    create: {
      blobContainer: BLOB_CONTAINER,
      blobKey,
      sha256: placeholderSha256(blobKey),
      sizeBytes,
      durationMs,
      contentType: CONTENT_TYPE,
    },
  });
}

async function main(): Promise<void> {
  const instructionsFile = await upsertPlaceholderFile(
    "system/operator-instructions-placeholder.flac",
    96_000,
    12_000,
  );

  for (const [index, prompt] of SAMPLE_QUESTIONS.entries()) {
    const sampleNumber = index + 1;
    const audio = await upsertPlaceholderFile(
      `system/sample-question-${sampleNumber}.flac`,
      64_000 + sampleNumber * 4_096,
      8_000 + sampleNumber * 750,
    );

    await prisma.question.upsert({
      where: { prompt },
      update: {
        audioId: audio.id,
        retiredAt: null,
      },
      create: {
        prompt,
        audioId: audio.id,
      },
    });
  }

  const questionCount = await prisma.question.count();
  // eslint-disable-next-line no-console
  console.log(
    `seeded ${SAMPLE_QUESTIONS.length} sample questions (${questionCount} total); instructions file ${instructionsFile.blobKey}`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
