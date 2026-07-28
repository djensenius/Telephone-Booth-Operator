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
