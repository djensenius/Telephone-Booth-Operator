type InteractionSession = {
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  durationMs: number | null;
  digitsDialed: string | null;
};

type InteractionEvent = {
  type: string;
  payload: unknown;
};

type InteractionPerDayBucket = {
  date: string;
  total: number;
  noSelection: number;
  messagesLeft: number;
};

type InteractionSessionSummary = {
  total: number;
  noSelection: number;
  messagesLeft: number;
  averageDurationMs: number | null;
  longestDurationMs: number | null;
  outcomes: Record<string, number>;
};

type InteractionActionsSummary = {
  digitsDialed: Record<string, number>;
  leaveMessageSelections: number;
  listenMessageSelections: number;
  instructionSelections: number;
  wrongNumberAttempts: number;
  messagePlaybackStarts: number;
  instructionPlaybackStarts: number;
};

type InteractionBreakdown = {
  noSelection: number;
  wrongNumberAttempts: number;
  messagesLeft: number;
  messagePlaybackStarts: number;
  instructionPlaybackStarts: number;
};

const NO_SELECTION_OUTCOME = "hung_up_before_dial";
const MESSAGE_LEFT_OUTCOME = "recording_completed";
const MESSAGE_PLAYBACK_STATE = "playing_message";
const INSTRUCTION_PLAYBACK_STATE = "playing_instructions";

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const incRecord = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

const emptyDigitsDialed = (): Record<string, number> =>
  Object.fromEntries(Array.from({ length: 10 }, (_, digit) => [String(digit), 0]));

export const emptyInteractionBreakdown = (): InteractionBreakdown => ({
  noSelection: 0,
  wrongNumberAttempts: 0,
  messagesLeft: 0,
  messagePlaybackStarts: 0,
  instructionPlaybackStarts: 0,
});

const minStartedAt = (sessions: readonly InteractionSession[]): Date | null => {
  if (sessions.length === 0) return null;
  let min = sessions[0]?.startedAt ?? null;
  for (const session of sessions) {
    if (!min || session.startedAt < min) min = session.startedAt;
  }
  return min;
};

const parseDigit = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const digit = (payload as { digit?: unknown }).digit;
  if (typeof digit !== "number" || !Number.isInteger(digit) || digit < 0 || digit > 9) {
    return null;
  }
  return String(digit);
};

const digitSelectionKey = (
  digit: string,
):
  | keyof Pick<
      InteractionActionsSummary,
      | "leaveMessageSelections"
      | "listenMessageSelections"
      | "instructionSelections"
      | "wrongNumberAttempts"
    >
  | null => {
  if (digit === "1") return "leaveMessageSelections";
  if (digit === "2") return "listenMessageSelections";
  if (digit === "0") return "instructionSelections";
  if (digit >= "3" && digit <= "9") return "wrongNumberAttempts";
  return null;
};

const playbackSelectionKey = (
  payload: unknown,
):
  | keyof Pick<InteractionActionsSummary, "messagePlaybackStarts" | "instructionPlaybackStarts">
  | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const to = (payload as { to?: unknown }).to;
  if (to === MESSAGE_PLAYBACK_STATE) return "messagePlaybackStarts";
  if (to === INSTRUCTION_PLAYBACK_STATE) return "instructionPlaybackStarts";
  return null;
};

export const summarizeInteractionSessions = (
  sessions: readonly InteractionSession[],
): InteractionSessionSummary => {
  const outcomes: Record<string, number> = {};
  const durations: number[] = [];
  let noSelection = 0;
  let messagesLeft = 0;

  for (const session of sessions) {
    if (session.outcome === NO_SELECTION_OUTCOME) noSelection += 1;
    if (session.outcome === MESSAGE_LEFT_OUTCOME) messagesLeft += 1;
    if (typeof session.durationMs === "number") durations.push(session.durationMs);
    if (session.endedAt === null && session.outcome === null) continue;
    incRecord(outcomes, session.outcome ?? "unknown");
  }

  return {
    total: sessions.length,
    noSelection,
    messagesLeft,
    averageDurationMs:
      durations.length > 0
        ? durations.reduce((total, value) => total + value, 0) / durations.length
        : null,
    longestDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    outcomes,
  };
};

export const buildInteractionPerDay = (
  rangeStart: Date | null,
  rangeEnd: Date,
  sessions: readonly InteractionSession[],
): InteractionPerDayBucket[] => {
  const startDay = rangeStart ?? minStartedAt(sessions) ?? rangeEnd;
  const buckets = new Map<string, { total: number; noSelection: number; messagesLeft: number }>();
  const cursor = new Date(
    Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()),
  );
  const endDay = new Date(
    Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate()),
  );
  while (cursor.getTime() <= endDay.getTime()) {
    buckets.set(isoDay(cursor), { total: 0, noSelection: 0, messagesLeft: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  for (const session of sessions) {
    const key = isoDay(session.startedAt);
    const bucket = buckets.get(key) ?? { total: 0, noSelection: 0, messagesLeft: 0 };
    bucket.total += 1;
    if (session.outcome === NO_SELECTION_OUTCOME) bucket.noSelection += 1;
    if (session.outcome === MESSAGE_LEFT_OUTCOME) bucket.messagesLeft += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
};

export const summarizeInteractionActions = (
  events: readonly InteractionEvent[],
): InteractionActionsSummary => {
  const summary: InteractionActionsSummary = {
    digitsDialed: emptyDigitsDialed(),
    leaveMessageSelections: 0,
    listenMessageSelections: 0,
    instructionSelections: 0,
    wrongNumberAttempts: 0,
    messagePlaybackStarts: 0,
    instructionPlaybackStarts: 0,
  };

  for (const event of events) {
    if (event.type === "digit_dialed") {
      const digit = parseDigit(event.payload);
      if (digit === null) continue;
      incRecord(summary.digitsDialed, digit);
      const selection = digitSelectionKey(digit);
      if (selection) summary[selection] += 1;
      continue;
    }

    if (event.type === "state_transition") {
      const playback = playbackSelectionKey(event.payload);
      if (playback) summary[playback] += 1;
    }
  }

  return summary;
};

export const summarizeInteractionBreakdown = (
  sessions: readonly InteractionSession[],
  events: readonly InteractionEvent[],
): InteractionBreakdown => {
  const sessionSummary = summarizeInteractionSessions(sessions);
  const actionSummary = summarizeInteractionActions(events);
  return {
    noSelection: sessionSummary.noSelection,
    wrongNumberAttempts: actionSummary.wrongNumberAttempts,
    messagesLeft: sessionSummary.messagesLeft,
    messagePlaybackStarts: actionSummary.messagePlaybackStarts,
    instructionPlaybackStarts: actionSummary.instructionPlaybackStarts,
  };
};

export const tallyLegacyDigitHistogram = (
  sessions: readonly InteractionSession[],
  digitEvents: readonly InteractionEvent[],
): Record<string, number> => {
  if (digitEvents.length > 0) return summarizeInteractionActions(digitEvents).digitsDialed;

  const digits = emptyDigitsDialed();
  for (const session of sessions) {
    if (!session.digitsDialed) continue;
    for (const char of session.digitsDialed) {
      if (char in digits) incRecord(digits, char);
    }
  }
  return digits;
};
