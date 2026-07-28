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

// Raw snapshots to request/cache. Pre-migration history is one row per
// heartbeat, so a 50-row fetch could collapse to a single displayed status and
// hide every transition before it. Over-fetching raw rows and collapsing down
// to `STATUS_HISTORY_DISPLAY_LIMIT` keeps the panel useful for that legacy data
// (post-migration the API already returns one row per status).
export const STATUS_HISTORY_LIMIT = 200;

/** How many collapsed booth statuses the status panel shows. */
export const STATUS_HISTORY_DISPLAY_LIMIT = 50;

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
 * A frame that repeats the head *row* is that row re-broadcast by the API, so
 * it replaces the head (the server's window and `repeatCount` are
 * authoritative). Anything else is a genuine transition and is prepended,
 * including a return to a status the booth held earlier: that run's window
 * starts after the previous run ended, so it can never overwrite it.
 */
export function mergeLiveStatus(
  history: readonly BoothStatus[],
  status: BoothStatus,
  limit: number = STATUS_HISTORY_LIMIT,
): readonly BoothStatus[] {
  const [head, ...rest] = history;
  if (head && isSameRun(head, status)) {
    // Frames for one row can arrive out of order (the API awaits idle
    // reconciliation before broadcasting), so keep the newer of the two rather
    // than rewinding the window and the count.
    return isStaleFrame(head, status) ? history : [status, ...rest];
  }
  return [status, ...history].slice(0, limit);
}

function isStaleFrame(head: BoothStatus, status: BoothStatus): boolean {
  const headUpdatedAt = Date.parse(head.updatedAt);
  const updatedAt = Date.parse(status.updatedAt);
  if (updatedAt !== headUpdatedAt) return updatedAt < headUpdatedAt;
  return repeatCountOf(status) < repeatCountOf(head);
}

// Same booth status *and* same run. Run identity is the reported window rather
// than `firstSeenAt` alone: a repeat that reaches the API out of order widens
// the window backwards, so the same row can be re-broadcast with an earlier
// `firstSeenAt` than the copy we cached. A run's window only ever grows, so two
// views of one run are an identical status where one window contains the other.
//
// Containment rather than plain overlap matters when transitions share a
// timestamp: `idle [a, t]`, `recording [t, t]`, `idle [t, b]` leaves two idle
// windows touching at `t`, and they are separate runs.
//
// A legacy API sends no window at all, so both sides collapse to their
// `updatedAt` instant and only an identical instant could match — which the
// caller has already handled as a duplicate frame.
function isSameRun(a: BoothStatus, b: BoothStatus): boolean {
  if (!isSameStatus(a, b)) return false;
  const aStart = Date.parse(firstSeenAtOf(a));
  const bStart = Date.parse(firstSeenAtOf(b));
  const aEnd = Date.parse(a.updatedAt);
  const bEnd = Date.parse(b.updatedAt);
  return (aStart <= bStart && aEnd >= bEnd) || (bStart <= aStart && bEnd >= aEnd);
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
