import { z } from "zod";

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type LocalDateRange = {
  start: Date;
  end: Date;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTER_CACHE_SIZE = 32;

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatterCache.get(timeZone);
  if (formatter) return formatter;

  const candidate = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const canonicalTimeZone = candidate.resolvedOptions().timeZone;
  formatter = formatterCache.get(canonicalTimeZone);
  if (formatter) return formatter;

  if (formatterCache.size >= MAX_FORMATTER_CACHE_SIZE) {
    const oldest = formatterCache.keys().next().value;
    if (oldest !== undefined) formatterCache.delete(oldest);
  }
  formatterCache.set(canonicalTimeZone, candidate);
  return candidate;
};

const canonicalTimeZone = (timeZone: string): string =>
  formatterFor(timeZone).resolvedOptions().timeZone;

const partsFor = (date: Date, timeZone: string): DateTimeParts => {
  const parts = formatterFor(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    if (!raw) throw new Error(`Unable to resolve ${type} in ${timeZone}.`);
    return Number(raw);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

const partsAsUtc = (parts: DateTimeParts): number =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

const pad = (value: number): string => String(value).padStart(2, "0");

const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE_SEARCH_WINDOW_MS = 48 * 60 * 60 * 1000;
const TIME_ZONE_SCAN_STEP_MS = 30 * 60 * 1000;
const UTC_DATE_SAMPLE_STEP_MS = 6 * 60 * 60 * 1000;

const parseLocalDate = (localDate: string): Pick<DateTimeParts, "year" | "month" | "day"> => {
  const match = localDatePattern.exec(localDate);
  if (!match) throw new Error(`Invalid local date: ${localDate}.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid local date: ${localDate}.`);
  }
  return { year, month, day };
};

export const DEFAULT_TIME_ZONE = "America/Toronto";

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

export const IanaTimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "timeZone must be a valid IANA time zone.");

export const dateKeyInTimeZone = (date: Date, timeZone: string): string => {
  const local = partsFor(date, timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
};

const offsetAt = (timestamp: number, timeZone: string): number => {
  const wholeSecond = Math.floor(timestamp / 1_000) * 1_000;
  return partsAsUtc(partsFor(new Date(wholeSecond), timeZone)) - wholeSecond;
};

const offsetsAndTransitions = (
  start: number,
  end: number,
  timeZone: string,
): { offsets: Set<number>; transitions: number[] } => {
  const offsets = new Set<number>();
  const transitions: number[] = [];
  let previousTime = start;
  let previousOffset = offsetAt(start, timeZone);
  offsets.add(previousOffset);

  while (previousTime < end) {
    const currentTime = Math.min(previousTime + TIME_ZONE_SCAN_STEP_MS, end);
    const currentOffset = offsetAt(currentTime, timeZone);
    offsets.add(currentOffset);
    if (currentOffset !== previousOffset) {
      let lowerSecond = Math.floor(previousTime / 1_000);
      let upperSecond = Math.ceil(currentTime / 1_000);
      while (lowerSecond < upperSecond) {
        const midpoint = lowerSecond + Math.floor((upperSecond - lowerSecond) / 2);
        if (offsetAt(midpoint * 1_000, timeZone) === previousOffset) {
          lowerSecond = midpoint + 1;
        } else {
          upperSecond = midpoint;
        }
      }
      transitions.push(lowerSecond * 1_000);
    }
    previousTime = currentTime;
    previousOffset = currentOffset;
  }

  return { offsets, transitions };
};

export const rangesForDateInTimeZone = (localDate: string, timeZone: string): LocalDateRange[] => {
  const resolvedTimeZone = canonicalTimeZone(timeZone);
  const local = parseLocalDate(localDate);
  const target = Date.UTC(local.year, local.month - 1, local.day);
  const nextTarget = Date.UTC(local.year, local.month - 1, local.day + 1);
  const searchStart = target - TIME_ZONE_SEARCH_WINDOW_MS;
  const searchEnd = nextTarget + TIME_ZONE_SEARCH_WINDOW_MS;
  const { offsets, transitions } = offsetsAndTransitions(searchStart, searchEnd, resolvedTimeZone);
  const boundaries = new Set<number>([searchStart, searchEnd, ...transitions]);
  for (const offset of offsets) {
    boundaries.add(target - offset);
    boundaries.add(nextTarget - offset);
  }
  const sortedBoundaries = [...boundaries]
    .filter((timestamp) => timestamp >= searchStart && timestamp <= searchEnd)
    .sort((left, right) => left - right);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index]!;
    const endExclusive = sortedBoundaries[index + 1]!;
    if (endExclusive <= start) continue;
    const midpoint = start + Math.floor((endExclusive - start) / 2);
    if (dateKeyInTimeZone(new Date(midpoint), resolvedTimeZone) !== localDate) continue;
    const end = endExclusive - 1;
    const previous = ranges.at(-1);
    if (previous && previous.end + 1 === start) {
      previous.end = end;
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map((range) => ({ start: new Date(range.start), end: new Date(range.end) }));
};

export const dateKeysInUtcRange = (start: Date, end: Date, timeZone: string): string[] => {
  if (end.getTime() < start.getTime()) {
    throw new Error("UTC range end must be on or after its start.");
  }
  const resolvedTimeZone = canonicalTimeZone(timeZone);
  const dates = new Set<string>();
  for (
    let timestamp = start.getTime();
    timestamp <= end.getTime();
    timestamp += UTC_DATE_SAMPLE_STEP_MS
  ) {
    dates.add(dateKeyInTimeZone(new Date(timestamp), resolvedTimeZone));
  }
  dates.add(dateKeyInTimeZone(end, resolvedTimeZone));

  const { transitions } = offsetsAndTransitions(start.getTime(), end.getTime(), resolvedTimeZone);
  for (const transition of transitions) {
    if (transition > start.getTime()) {
      dates.add(dateKeyInTimeZone(new Date(transition - 1), resolvedTimeZone));
    }
    if (transition <= end.getTime()) {
      dates.add(dateKeyInTimeZone(new Date(transition), resolvedTimeZone));
    }
  }
  return [...dates].sort();
};

export const startOfDateInTimeZone = (localDate: string, timeZone: string): Date => {
  const firstRange = rangesForDateInTimeZone(localDate, timeZone)[0];
  if (!firstRange) throw new Error(`Local date ${localDate} does not exist in ${timeZone}.`);
  return firstRange.start;
};

export const startOfDayInTimeZone = (now: Date, timeZone: string): Date =>
  startOfDateInTimeZone(dateKeyInTimeZone(now, timeZone), timeZone);
