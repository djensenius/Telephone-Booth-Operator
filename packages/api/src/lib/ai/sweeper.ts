// Recovery sweeper for the AI pipeline. Periodically scans for `received`
// messages with no successful transcription and re-kicks the pipeline.
// Covers server restarts mid-pipeline and provider outages.

import { db } from "../db.js";
import { resolveAiConfig } from "./config.js";
import { kickPipelineForMessage } from "./pipeline.js";

const findStrandedMessages = async (
  limit: number,
  staleThresholdMs: number,
): Promise<readonly string[]> => {
  const messages = await db.message.findMany({
    where: { status: "received" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      transcriptions: {
        select: { id: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  // A transcription row is considered stuck if it has been pending longer than
  // the configured stale threshold. This covers the case where the API crashed
  // after writing the pending row but before the provider returned.
  const pendingStaleAfter = Date.now() - staleThresholdMs;
  const stranded: string[] = [];
  for (const message of messages) {
    const latest = (
      message as unknown as { transcriptions: Array<{ status: string; createdAt: Date }> }
    ).transcriptions[0];
    if (!latest || latest.status === "failed") {
      stranded.push(message.id);
    } else if (latest.status === "pending" && latest.createdAt.getTime() < pendingStaleAfter) {
      stranded.push(message.id);
    }
  }
  return stranded;
};

export interface SweeperHandle {
  stop(): void;
}

export const startAiSweeper = (): SweeperHandle | null => {
  const config = resolveAiConfig();
  if (config.transcriptionProvider === "disabled") return null;

  const intervalMs = Math.max(5, config.sweeperIntervalSeconds) * 1000;
  const staleThresholdMs = config.sweeperStaleThresholdSeconds * 1000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const stranded = await findStrandedMessages(20, staleThresholdMs);
      for (const id of stranded) kickPipelineForMessage(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "sweeper failed";
      console.warn(JSON.stringify({ event: "ai.sweeper.error", reason }));
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  handle.unref();

  // Run once shortly after boot so restarts don't wait a full interval.
  setTimeout(() => void tick(), 1_000).unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
  };
};
