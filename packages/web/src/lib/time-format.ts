// Compact timestamp formatting for dense lists. Absolute `toLocaleString()`
// output wraps badly in narrow columns, so lists show a relative label and
// keep the full timestamp in a `title` / `<time dateTime>` attribute.

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * "just now", "5m ago", "3h ago", "2d ago", … for an ISO timestamp.
 * Returns `null` when the value is missing or unparseable.
 */
export function relativeTime(
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const deltaMs = parsed - now;
  const magnitude = Math.abs(deltaMs);
  if (magnitude < MINUTE) return "just now";
  if (magnitude < HOUR) return RELATIVE.format(Math.round(deltaMs / MINUTE), "minute");
  if (magnitude < DAY) return RELATIVE.format(Math.round(deltaMs / HOUR), "hour");
  if (magnitude < WEEK) return RELATIVE.format(Math.round(deltaMs / DAY), "day");
  return RELATIVE.format(Math.round(deltaMs / WEEK), "week");
}

/** Full, locale-aware timestamp for tooltips and detail views. */
export function absoluteTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleString();
}

/** Recording length as a short "1m 04s" / "9s" string. */
export function durationLabel(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
