export const TELEMETRY_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

export function isTelemetryFresh(
  receivedAt: string | null | undefined,
  nowMilliseconds: number = Date.now(),
): boolean {
  if (!receivedAt) return false;
  const receivedAtMilliseconds = Date.parse(receivedAt);
  return (
    Number.isFinite(receivedAtMilliseconds) &&
    nowMilliseconds - receivedAtMilliseconds < TELEMETRY_FRESHNESS_WINDOW_MS
  );
}
