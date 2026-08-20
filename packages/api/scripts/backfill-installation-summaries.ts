/**
 * Recompute frozen summaries for ended installations.
 *
 * Dry-run by default; pass --apply to write the recomputed summary JSON back to
 * the Installation rows.
 */
import { db } from "../src/lib/db.js";
import {
  parseInstallationSummaryBackfillArgs,
  runInstallationSummaryBackfill,
} from "../src/lib/installation-summary-backfill.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseInstallationSummaryBackfillArgs(argv);
  const report = await runInstallationSummaryBackfill(
    db,
    {
      info: (message) => {
        // oxlint-disable-next-line no-console
        console.log(message);
      },
      error: (message) => {
        // oxlint-disable-next-line no-console
        console.error(message);
      },
    },
    options,
  );

  if (report.failures.length > 0) {
    throw new Error(
      `Installation summary backfill completed with ${report.failures.length} failure(s).`,
    );
  }
}

if (import.meta.main) {
  main()
    .catch((error: unknown) => {
      // oxlint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
