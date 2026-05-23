/**
 * Seed script — idempotent. Populates a minimal set of sample questions
 * so a fresh install isn't a blank page.
 *
 * Re-run with `just db-seed`.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SAMPLE_QUESTIONS = [
  "What's a moment from the last year you'd like to remember?",
  "What's something you've never told anyone?",
  "Describe the room you grew up in.",
  "What would you say to your 15-year-old self?",
  "What's the kindest thing a stranger ever did for you?",
];

async function main(): Promise<void> {
  // Placeholder for a real seed — we'll need an audio File row to attach.
  // The first-run flow records the operator's voice via the operator UI
  // and inserts the real rows then; this script merely confirms the DB
  // connection works on `just db-seed`.
  const count = await prisma.question.count();
  // eslint-disable-next-line no-console
  console.log(`current question count: ${count} (sample list: ${SAMPLE_QUESTIONS.length})`);
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
