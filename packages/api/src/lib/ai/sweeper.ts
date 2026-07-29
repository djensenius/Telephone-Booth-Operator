// Recovery sweeper for the AI pipeline. Periodically scans for undecided
// messages whose in-process transcription attempt was interrupted and re-kicks
// the pipeline. Covers server restarts mid-pipeline and provider outages.

import { db } from "../db.js";
import { broadcastWork } from "../broadcaster.js";
import { resolveAiConfig } from "./config.js";
import { kickPipelineForMessage } from "./pipeline.js";
import { findOutstandingPushWork } from "./push-work.js";

// Undecided messages. A completed upload lands in `pending`; `received` only
// occurs for messages recorded before transcription became optional, so both
// are scanned.
const UNDECIDED_STATUSES = ["received", "pending"] as const;

// Exported for tests.
export const findStrandedMessages = async (
  limit: number,
  staleThresholdMs: number,
): Promise<readonly string[]> => {
  const staleBefore = new Date(Date.now() - staleThresholdMs);
  // Narrow to recovery candidates *before* applying the limit. `pending` is now
  // the steady state for every undecided message, so filtering afterwards would
  // let a page of healthy recent messages permanently hide an older stranded
  // one from every sweep.
  const messages = await db.message.findMany({
    where: {
      status: { in: [...UNDECIDED_STATUSES] },
      OR: [
        { transcriptions: { none: {} } },
        { transcriptions: { some: { status: "pending", createdAt: { lt: staleBefore } } } },
      ],
    },
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
  // The `some` clause above matches on *any* stale pending row, so re-check
  // against the latest one: a message that has since been re-transcribed
  // successfully is not stranded.
  //
  // Only *interrupted* attempts are recovered: no row at all (the fire-and-
  // forget kick was lost to a restart), or a row that has been pending longer
  // than the stale threshold (the API crashed after writing it but before the
  // provider returned).
  //
  // A `failed` row is a completed attempt and is deliberately left alone. The
  // message is already visible in the operator queue, so retrying it every
  // interval forever would just burn provider spend; an operator re-runs it
  // explicitly via `POST /v1/messages/:id/transcribe`.
  const stranded: string[] = [];
  for (const message of messages) {
    const latest = (
      message as unknown as { transcriptions: Array<{ status: string; createdAt: Date }> }
    ).transcriptions[0];
    if (!latest) {
      stranded.push(message.id);
    } else if (latest.status === "pending" && latest.createdAt < staleBefore) {
      stranded.push(message.id);
    }
  }
  return stranded;
};

const reemitStalePushWork = async (staleThresholdMs: number): Promise<void> => {
  const staleBefore = new Date(Date.now() - staleThresholdMs);
  const outstanding = await findOutstandingPushWork({ staleBefore, limit: 20 });
  for (const work of outstanding) broadcastWork(work.messageId, work.needs);
};

export interface SweeperHandle {
  stop(): void;
}

export const startAiSweeper = (): SweeperHandle | null => {
  const config = resolveAiConfig();
  // In-process transcription is the only thing that can be interrupted
  // mid-flight and need recovery. For `push` the app owns the schedule and the
  // API never solicits the work; for `disabled` there is nothing to run.
  const recoversTranscription =
    config.transcriptionProvider !== "push" && config.transcriptionProvider !== "disabled";
  // Translation and moderation are separate providers and may still be in push
  // mode even when transcription is not, so their stale `work` envelopes are
  // re-emitted regardless.
  const reemitsPushWork =
    config.translationProvider === "push" || config.moderationProvider === "push";
  if (!recoversTranscription && !reemitsPushWork) return null;

  const intervalMs = Math.max(5, config.sweeperIntervalSeconds) * 1000;
  const staleThresholdMs = config.sweeperStaleThresholdSeconds * 1000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (recoversTranscription) {
        const stranded = await findStrandedMessages(20, staleThresholdMs);
        for (const id of stranded) kickPipelineForMessage(id);
      }
      if (reemitsPushWork) await reemitStalePushWork(staleThresholdMs);
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
