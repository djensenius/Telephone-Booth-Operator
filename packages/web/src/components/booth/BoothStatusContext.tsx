import { createContext, useContext, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

export type BoothDisplayStatus = "idle" | "playing" | "recording" | "error";
export type BoothConnectionStatus = "connected" | "disconnected";

export interface BoothStatusContextValue {
  readonly status: BoothDisplayStatus;
  readonly connectionStatus: BoothConnectionStatus;
  readonly lastError: string | null;
  readonly muted: boolean;
  readonly reducedMotionOverride: boolean;
  readonly setStatus: (status: BoothDisplayStatus) => void;
  readonly setConnectionStatus: (status: BoothConnectionStatus) => void;
  readonly setLastError: (error: string | null) => void;
  readonly setMuted: (muted: boolean) => void;
  readonly setReducedMotionOverride: (enabled: boolean) => void;
}

const BoothStatusContext = createContext<BoothStatusContextValue | undefined>(undefined);

function readBooleanSetting(key: string, fallback: boolean): boolean {
  if (import.meta.env.MODE === "test" || typeof window === "undefined") {
    return fallback;
  }
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeBooleanSetting(key: string, value: boolean): void {
  if (import.meta.env.MODE === "test" || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in privacy mode or opaque test origins.
  }
}

export interface BoothStatusProviderProps extends PropsWithChildren {
  readonly initialStatus?: BoothDisplayStatus;
  readonly initialConnectionStatus?: BoothConnectionStatus;
  readonly initialLastError?: string | null;
}

export function BoothStatusProvider({
  children,
  initialStatus = "idle",
  initialConnectionStatus = "connected",
  initialLastError = null,
}: BoothStatusProviderProps): JSX.Element {
  const [status, setStatus] = useState<BoothDisplayStatus>(initialStatus);
  const [connectionStatus, setConnectionStatus] =
    useState<BoothConnectionStatus>(initialConnectionStatus);
  const [lastError, setLastError] = useState<string | null>(initialLastError);
  const [mutedState, setMutedState] = useState(() =>
    readBooleanSetting("booth.audio.muted", false),
  );
  const [overrideState, setOverrideState] = useState(() =>
    readBooleanSetting("booth.motion.override", false),
  );

  const value = useMemo<BoothStatusContextValue>(() => {
    function setMuted(muted: boolean): void {
      setMutedState(muted);
      writeBooleanSetting("booth.audio.muted", muted);
    }

    function setReducedMotionOverride(enabled: boolean): void {
      setOverrideState(enabled);
      writeBooleanSetting("booth.motion.override", enabled);
    }

    return {
      status,
      connectionStatus,
      lastError,
      muted: mutedState,
      reducedMotionOverride: overrideState,
      setStatus,
      setConnectionStatus,
      setLastError,
      setMuted,
      setReducedMotionOverride,
    };
  }, [connectionStatus, lastError, mutedState, overrideState, status]);

  return <BoothStatusContext.Provider value={value}>{children}</BoothStatusContext.Provider>;
}

export function useBoothStatus(): BoothStatusContextValue {
  const context = useContext(BoothStatusContext);
  if (context === undefined) {
    throw new Error("useBoothStatus must be used within BoothStatusProvider");
  }
  return context;
}
