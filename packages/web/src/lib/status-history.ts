// Booth status history helpers.
//
// The booth re-reports its current status on a heartbeat, so an unchanged booth
// produces many identical reports. The API folds those into a single snapshot
// row (`firstSeenAt`..`updatedAt` plus `repeatCount`), but the operator console
// still has to cope with two sources of duplication:
//
//   1. Live WebSocket frames re-send the *same* collapsed row on every
//      heartbeat — prepending them blindly would rebuild the wall of identical
//      rows client-side. `mergeLiveStatus` replaces the head instead.
//   2. Snapshots written before the API collapsed anything are separate rows
//      that each count once. `collapseStatusHistory` folds those runs together
//      at render time so old history reads the same as new history.

import type { BoothStatus } from "@telephone-booth-operator/shared";

/** Newest-first history capped to the same window the API returns. */
export const STATUS_HISTORY_LIMIT = 50;

/** True when two snapshots describe the same booth status (ignoring timing). */
export function isSameStatus(a: BoothStatus, b: BoothStatus): boolean {
  return (
    a.state === b.state &&
    (a.currentQuestionId ?? null) === (b.currentQuestionId ?? null) &&
    (a.currentMessageId ?? null) === (b.currentMessageId ?? null) &&
    (a.lastError ?? null) === (b.lastError ?? null) &&
    (a.runtimeMode ?? null) === (b.runtimeMode ?? null)
  );
}

/** How many reports a snapshot stands for; older API builds omit the count. */
export function repeatCountOf(status: BoothStatus): number {
  return status.repeatCount ?? 1;
}

/** When the booth entered this status; falls back to the report timestamp. */
export function firstSeenAtOf(status: BoothStatus): string {
  return status.firstSeenAt ?? status.updatedAt;
}

/**
 * Fold a live status frame into the cached newest-first history.
 *
 * A frame that repeats the head is the head row re-broadcast by the API, so it
 * replaces the head (its `repeatCount` is already authoritative). Anything else
 * is a genuine transition and is prepended.
 */
export function mergeLiveStatus(
  history: readonly BoothStatus[],
  status: BoothStatus,
  limit: number = STATUS_HISTORY_LIMIT,
): readonly BoothStatus[] {
  const [head, ...rest] = history;
  if (head && isSameStatus(head, status)) return [status, ...rest];
  return [status, ...history].slice(0, limit);
}

/**
 * Collapse consecutive identical snapshots into one entry per booth status,
 * summing their repeat counts and widening the `firstSeenAt`..`updatedAt`
 * window. Input and output are newest-first.
 */
export function collapseStatusHistory(history: readonly BoothStatus[]): readonly BoothStatus[] {
  const collapsed: BoothStatus[] = [];
  for (const status of history) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && isSameStatus(previous, status)) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        firstSeenAt: earlier(firstSeenAtOf(previous), firstSeenAtOf(status)),
        updatedAt: later(previous.updatedAt, status.updatedAt),
        repeatCount: repeatCountOf(previous) + repeatCountOf(status),
      };
      continue;
    }
    collapsed.push({
      ...status,
      firstSeenAt: firstSeenAtOf(status),
      repeatCount: repeatCountOf(status),
    });
  }
  return collapsed;
}

// Timestamp pickers that fall back to the first argument for unparseable input
// rather than producing a NaN comparison.
function earlier(a: string, b: string): string {
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}
