export class BusyBarConfigurationError extends Error {
  override name = "BusyBarConfigurationError";
}

export type BusyBarMonitorConfig =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      apiUrl: string;
      cloudWebSocketUrl: string;
      deviceId: string | null;
      applicationName: string;
      displayPriority: number;
      staleAfterMs: number;
      renderDebounceMs: number;
      frontRotationMs: number;
      audioEnabled: boolean;
      alertSound: string | null;
      alertCooldownMs: number;
    };

const value = (input: string | undefined): string | undefined => {
  const trimmed = input?.trim();
  return trimmed ? trimmed : undefined;
};

const integer = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = value(env[name]);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BusyBarConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
};

const url = (input: string, name: string, protocols: readonly string[]): string => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new BusyBarConfigurationError(`${name} must be a valid URL.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new BusyBarConfigurationError(`${name} must use ${protocols.join(" or ")}.`);
  }
  return parsed.toString().replace(/\/$/, "");
};

export const resolveBusyBarMonitorConfig = (
  env: NodeJS.ProcessEnv = process.env,
): BusyBarMonitorConfig => {
  if (env.BUSY_BAR_MONITOR_ENABLED !== "true") return { enabled: false };
  const token = value(env.BUSY_BAR_CLOUD_TOKEN);
  if (!token) {
    throw new BusyBarConfigurationError(
      "BUSY_BAR_CLOUD_TOKEN is required when BUSY_BAR_MONITOR_ENABLED=true.",
    );
  }
  const audioEnabled = env.BUSY_BAR_AUDIO_ENABLED !== "false";
  const alertSound = value(env.BUSY_BAR_ALERT_SOUND) ?? null;
  if (audioEnabled && !alertSound) {
    throw new BusyBarConfigurationError(
      "BUSY_BAR_ALERT_SOUND is required when BUSY_BAR_AUDIO_ENABLED is enabled.",
    );
  }
  return {
    enabled: true,
    token,
    apiUrl: url(value(env.BUSY_BAR_API_URL) ?? "https://api.busy.app", "BUSY_BAR_API_URL", [
      "https:",
      "http:",
    ]),
    cloudWebSocketUrl: url(
      value(env.BUSY_BAR_CLOUD_WS_URL) ?? "wss://api.busy.app/api/v1/bars/ws",
      "BUSY_BAR_CLOUD_WS_URL",
      ["wss:", "ws:"],
    ),
    deviceId: value(env.BUSY_BAR_DEVICE_ID) ?? null,
    applicationName: value(env.BUSY_BAR_APPLICATION_NAME) ?? "telephone-booth-monitor",
    displayPriority: integer(env, "BUSY_BAR_DISPLAY_PRIORITY", 100, 1, 100),
    staleAfterMs: integer(env, "BUSY_BAR_STALE_AFTER_SECONDS", 20, 5, 3600) * 1000,
    renderDebounceMs: integer(env, "BUSY_BAR_RENDER_DEBOUNCE_MS", 250, 0, 10_000),
    frontRotationMs: integer(env, "BUSY_BAR_FRONT_ROTATION_SECONDS", 8, 3, 60) * 1000,
    audioEnabled,
    alertSound,
    alertCooldownMs: integer(env, "BUSY_BAR_ALERT_COOLDOWN_SECONDS", 300, 10, 86_400) * 1000,
  };
};
