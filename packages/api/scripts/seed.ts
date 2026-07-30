/**
 * Seed script — idempotent. Populates sample questions and placeholder
 * audio File rows so a fresh install has useful content to work with.
 *
 * Re-run with `just db-seed` or
 * `pnpm --filter @telephone-booth-operator/api run seed`.
 */
import { createHash } from "node:crypto";

import { db as prisma } from "../src/lib/db.js";

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
  // `exactOptionalPropertyTypes` means an explicit `undefined` is not a valid
  // value for Prisma's optional columns, so omit the key entirely instead.
  const duration = durationMs === undefined ? {} : { durationMs };

  return prisma.file.upsert({
    where: { blobKey },
    update: {
      blobContainer: BLOB_CONTAINER,
      sha256: placeholderSha256(blobKey),
      sizeBytes,
      ...duration,
      contentType: CONTENT_TYPE,
    },
    create: {
      blobContainer: BLOB_CONTAINER,
      blobKey,
      sha256: placeholderSha256(blobKey),
      sizeBytes,
      ...duration,
      contentType: CONTENT_TYPE,
    },
  });
}

async function main(): Promise<void> {
  // Questions belong to an installation, so seeding needs one to hang them on.
  const installation =
    (await prisma.installation.findFirst({ where: { endedAt: null } })) ??
    (await prisma.installation.create({ data: { name: "Installation 1" } }));

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
      where: { installationId_prompt: { installationId: installation.id, prompt } },
      update: {
        audioId: audio.id,
        status: "active",
        retiredAt: null,
      },
      create: {
        prompt,
        audioId: audio.id,
        status: "active",
        installationId: installation.id,
      },
    });
  }

  const questionCount = await prisma.question.count();
  // oxlint-disable-next-line no-console
  console.log(
    `seeded ${SAMPLE_QUESTIONS.length} sample questions (${questionCount} total); instructions file ${instructionsFile.blobKey}`,
  );
}

main()
  .catch((err) => {
    // oxlint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
