interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const partsFor = (date: Date, timeZone: string): DateTimeParts => {
  const parts = new Intl.DateTimeFormat("en-CA-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
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

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

export const startOfDayInTimeZone = (now: Date, timeZone: string): Date => {
  const localNow = partsFor(now, timeZone);
  const target = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  let candidate = target;

  // Resolve the UTC instant whose wall-clock representation is local midnight.
  // Repeating handles the offset change on daylight-saving transition days.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const represented = partsAsUtc(partsFor(new Date(candidate), timeZone));
    const adjustment = target - represented;
    candidate += adjustment;
    if (adjustment === 0) break;
  }

  return new Date(candidate);
};
