/**
 * Runtime smoke test for the Prisma 7 client.
 *
 * Every API test suite replaces `src/lib/db.ts` with a fake, and
 * `prisma migrate deploy` only validates migrations, so nothing else in CI ever
 * instantiates the driver adapter or the lazy proxy that `db.ts` exports. This
 * script runs the real client against a live Postgres so adapter and
 * proxy-binding regressions cannot pass unnoticed.
 *
 * Requires DATABASE_URL to point at a migrated database. Run with
 * `pnpm --filter @telephone-booth-operator/api run db:smoke`.
 */
import { db } from "../src/lib/db.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";

const verifyAtomicMessageClaim = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  // Separate Prisma clients force Postgres, rather than the in-process client
  // or fake DB, to arbitrate the same conditional lease statement.
  const first = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const second = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = randomUUID();
  const installationId = randomUUID();
  const userId = `claim-smoke-${suffix}`;
  const fileId = randomUUID();
  const messageId = randomUUID();
  try {
    await first.installation.create({
      data: {
        id: installationId,
        name: `claim smoke ${suffix}`,
        endedAt: new Date(),
      },
    });
    await first.operatorUser.create({
      data: {
        id: userId,
        oidcSub: userId,
        email: `${userId}@example.invalid`,
        name: "Claim smoke",
      },
    });
    await first.file.create({
      data: {
        id: fileId,
        blobContainer: "smoke",
        blobKey: `smoke/${suffix}.flac`,
        sha256: suffix.replaceAll("-", "").padEnd(64, "0"),
        sizeBytes: 1,
        contentType: "audio/flac",
      },
    });
    await first.message.create({
      data: {
        id: messageId,
        status: "pending",
        audioId: fileId,
        installationId,
      },
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const claim = (client: PrismaClient, leaseHash: string) =>
      client.message.updateMany({
        where: {
          id: messageId,
          installationId,
          status: { in: ["received", "pending"] },
          processingFailedAt: null,
          OR: [{ processingLeaseExpiresAt: null }, { processingLeaseExpiresAt: { lte: now } }],
        },
        data: {
          processingLeaseTokenHash: leaseHash,
          processingLeaseExpiresAt: expiresAt,
          processingLeasedAt: now,
          processingLeasedById: userId,
          processingSnapshotHash: "smoke-snapshot",
          processingAttemptCount: { increment: 1 },
        },
      });
    const [one, two] = await Promise.all([claim(first, "a"), claim(second, "b")]);
    if (one.count + two.count !== 1) {
      throw new Error(`Atomic message claim leased ${one.count + two.count} rows instead of one.`);
    }
    const message = await first.message.findUnique({ where: { id: messageId } });
    if (
      message?.processingAttemptCount !== 1 ||
      !["a", "b"].includes(message.processingLeaseTokenHash ?? "")
    ) {
      throw new Error("Atomic message claim left an unexpected persisted lease state.");
    }
    // oxlint-disable-next-line no-console
    console.log("atomic message claim -> exactly one lease");
  } finally {
    await first.message.deleteMany({ where: { id: messageId } });
    await first.file.deleteMany({ where: { id: fileId } });
    await first.operatorUser.deleteMany({ where: { id: userId } });
    await first.installation.deleteMany({ where: { id: installationId } });
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  }
};

async function main(): Promise<void> {
  // Touching a delegate goes through the proxy's `get` trap, which is what
  // forces the client to be constructed with the driver adapter.
  const questions = await db.question.count();
  // oxlint-disable-next-line no-console
  console.log(`question.count() -> ${questions}`);

  // The proxy has to bind functions to the real client for `this` to survive.
  // An unbound `$transaction` throws, so this asserts the binding itself.
  const [messages, files] = await db.$transaction([db.message.count(), db.file.count()]);
  // oxlint-disable-next-line no-console
  console.log(`$transaction -> messages=${messages}, files=${files}`);

  const rows = await db.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  if (Number(rows[0]?.ok) !== 1) {
    throw new Error(`Unexpected raw query result: ${JSON.stringify(rows)}`);
  }
  // oxlint-disable-next-line no-console
  console.log("$queryRaw -> ok");
  await verifyAtomicMessageClaim();
}

main()
  .catch((err: unknown) => {
    // oxlint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
