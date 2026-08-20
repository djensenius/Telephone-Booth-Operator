import type { InstallationSummary } from "@telephone-booth-operator/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import { computeInstallationSummary, parseInstallationSummary } from "./installation.js";

type BackfillInstallationRow = {
  id: string;
  name: string;
  endedAt: Date | null;
  summary: unknown;
};

type BackfillClient = Pick<
  PrismaClient,
  "$transaction" | "installation" | "message" | "callSession" | "question" | "boothEvent"
>;

type BackfillLogger = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export type InstallationSummaryBackfillArgs = {
  apply: boolean;
};

export type InstallationSummaryBackfillFailure = {
  installationId: string;
  installationName: string;
  error: string;
};

export type InstallationSummaryBackfillReport = {
  apply: boolean;
  endedInstallations: number;
  changed: number;
  unchanged: number;
  applied: number;
  failures: InstallationSummaryBackfillFailure[];
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const summarySnapshot = (summary: InstallationSummary | null): string => {
  if (summary === null) return "summary=null";
  const breakdown = summary.interactionBreakdown;
  return [
    `calls=${summary.calls}`,
    `interactions=${summary.interactions}`,
    `noSelection=${breakdown.noSelection}`,
    `wrongNumberAttempts=${breakdown.wrongNumberAttempts}`,
    `messagesLeft=${breakdown.messagesLeft}`,
    `messagePlaybackStarts=${breakdown.messagePlaybackStarts}`,
    `instructionPlaybackStarts=${breakdown.instructionPlaybackStarts}`,
  ].join(", ");
};

export const parseInstallationSummaryBackfillArgs = (
  argv: readonly string[],
): InstallationSummaryBackfillArgs => {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply };
};

const computeCurrentAndNextSummary = async (
  client: BackfillClient,
  row: BackfillInstallationRow,
): Promise<{ current: InstallationSummary | null; next: InstallationSummary }> => ({
  current: parseInstallationSummary(row.summary),
  next: await computeInstallationSummary(client, row.id),
});

export const runInstallationSummaryBackfill = async (
  client: BackfillClient,
  logger: BackfillLogger,
  options: InstallationSummaryBackfillArgs,
): Promise<InstallationSummaryBackfillReport> => {
  const endedInstallations = (
    (await client.installation.findMany({
      where: { endedAt: { not: null } },
      orderBy: { endedAt: "asc" },
    })) as unknown as BackfillInstallationRow[]
  ).filter((row) => row.endedAt !== null);

  let changed = 0;
  let unchanged = 0;
  let applied = 0;
  const failures: InstallationSummaryBackfillFailure[] = [];

  logger.info(
    `${options.apply ? "Applying" : "Dry-run"} installation summary backfill for ${endedInstallations.length} ended installation(s).`,
  );

  for (const row of endedInstallations) {
    try {
      if (!options.apply) {
        const { current, next } = await computeCurrentAndNextSummary(client, row);
        if (stableStringify(current) === stableStringify(next)) {
          unchanged += 1;
          logger.info(`skip ${row.id} (${row.name}) already up to date: ${summarySnapshot(next)}`);
          continue;
        }
        changed += 1;
        logger.info(
          `would update ${row.id} (${row.name}): ${summarySnapshot(current)} -> ${summarySnapshot(next)}`,
        );
        continue;
      }

      const updated = await client.$transaction(async (tx) => {
        const current = (await tx.installation.findUnique({
          where: { id: row.id },
        })) as unknown as BackfillInstallationRow | null;
        if (!current) throw new Error("installation not found");
        if (current.endedAt === null) throw new Error("installation is no longer ended");

        const before = parseInstallationSummary(current.summary);
        const next = await computeInstallationSummary(tx, row.id);
        if (stableStringify(before) === stableStringify(next)) {
          return { changed: false, before, after: next };
        }

        await tx.installation.update({
          where: { id: row.id },
          data: { summary: next },
        });
        return { changed: true, before, after: next };
      });

      if (!updated.changed) {
        unchanged += 1;
        logger.info(
          `skip ${row.id} (${row.name}) already up to date: ${summarySnapshot(updated.after)}`,
        );
        continue;
      }

      changed += 1;
      applied += 1;
      logger.info(
        `updated ${row.id} (${row.name}): ${summarySnapshot(updated.before)} -> ${summarySnapshot(updated.after)}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        installationId: row.id,
        installationName: row.name,
        error: message,
      });
      logger.error(`failed ${row.id} (${row.name}): ${message}`);
    }
  }

  logger.info(
    [
      `endedInstallations=${endedInstallations.length}`,
      `changed=${changed}`,
      `unchanged=${unchanged}`,
      `applied=${applied}`,
      `failures=${failures.length}`,
    ].join(" "),
  );

  return {
    apply: options.apply,
    endedInstallations: endedInstallations.length,
    changed,
    unchanged,
    applied,
    failures,
  };
};
