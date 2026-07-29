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
 * A frame that repeats a cached *row* is that row re-broadcast by the API, so
 * it replaces the cached copy (the server's window and `repeatCount` are
 * authoritative). Anything else is a genuine transition and is inserted at its
 * place in time, including a return to a status the booth held earlier: that
 * run's window starts after the previous run ended, so it can never overwrite
 * it.
 */
export function mergeLiveStatus(
  history: readonly BoothStatus[],
  status: BoothStatus,
  limit: number = STATUS_HISTORY_LIMIT,
): readonly BoothStatus[] {
  // Frames for one row can arrive out of order (the API awaits idle
  // reconciliation before broadcasting), so place the frame at its position in
  // time first: a delayed repeat of a row that a newer transition has already
  // pushed down belongs beside its cached copy, not at the head.
  const at = history.findIndex(
    (item) => Date.parse(item.updatedAt) <= Date.parse(status.updatedAt),
  );
  const index = at === -1 ? history.length : at;
  // The API sends the snapshot's row id, so a frame can be matched to its
  // cached copy wherever it sits. Without one (a legacy API), only the entries
  // either side of the frame's position can be the same row: matching by value
  // across the whole history would drop a genuine transition, since the booth
  // supplies `updatedAt` and `idle`, a blip of `recording`, and `idle` again
  // can share one millisecond.
  const candidates =
    status.id === undefined ? [index - 1, index] : history.map((_, position) => position);
  const cached = candidates.find((candidate) => {
    const entry = history[candidate];
    return entry !== undefined && isSameRun(entry, status);
  });
  if (cached !== undefined) {
    // The server's window and `repeatCount` are authoritative, so the newer of
    // the two views wins and neither ever rewinds.
    const entry = history[cached] as BoothStatus;
    if (isStaleFrame(entry, status)) return history;
    const replaced = [...history];
    replaced[cached] = status;
    return replaced;
  }
  return [...history.slice(0, index), status, ...history.slice(index)].slice(0, limit);
}

/** Whether `status` is the newest report the console has seen. */
export function isNewerThan(status: BoothStatus, current: BoothStatus | null): boolean {
  if (!current) return true;
  // Another view of the row on display: only its own progress can move it on.
  if (status.id !== undefined && status.id === current.id) return !isStaleFrame(current, status);
  const delta = Date.parse(status.updatedAt) - Date.parse(current.updatedAt);
  if (delta !== 0) return delta > 0;
  // The same instant, two different rows. Ids record insertion order, which is
  // how the API itself breaks that tie — but only that tie: an id is assigned
  // when the report is processed, so a delayed report gets a high id and an
  // old `updatedAt`.
  if (status.id !== undefined && current.id !== undefined) return status.id > current.id;
  if (!isSameStatus(current, status)) return true;
  return !isStaleFrame(current, status);
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
// Rows carry an id, so this window rule only applies to a legacy API that sends
// neither. A legacy API sends no window at all, so both sides collapse to their
// `updatedAt` instant and only an identical instant could match — which the
// caller has already handled as a duplicate frame.
function isSameRun(a: BoothStatus, b: BoothStatus): boolean {
  // Ids are exact: two views of one row, or two rows that merely look alike.
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
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
