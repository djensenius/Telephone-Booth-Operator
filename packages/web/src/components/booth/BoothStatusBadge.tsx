import { useEffect, useState } from "react";
import { useBoothStatus } from "./BoothStatusContext.js";
import type { BoothDisplayStatus } from "./BoothStatusContext.js";
import { RuntimeModeBadge } from "./RuntimeModeBadge.js";

const STATUS_LABELS = {
  idle: "Idle",
  playing: "Playing",
  recording: "Recording",
  error: "Error",
} satisfies Record<BoothDisplayStatus, string>;

type StalenessLevel = "fresh" | "warning" | "offline";

const STALE_WARNING_MS = 60_000;
const STALE_OFFLINE_MS = 300_000;

function computeStaleness(lastStatusAt: Date | null): {
  level: StalenessLevel;
  label: string | null;
} {
  if (lastStatusAt === null) return { level: "fresh", label: null };
  const elapsed = Date.now() - lastStatusAt.getTime();
  if (elapsed < STALE_WARNING_MS) return { level: "fresh", label: null };
  if (elapsed < STALE_OFFLINE_MS) {
    const mins = Math.round(elapsed / 60_000);
    return { level: "warning", label: `Last seen ${mins}m ago` };
  }
  return { level: "offline", label: "Booth offline" };
}

function useStaleness(): { level: StalenessLevel; label: string | null } {
  const { lastStatusAt } = useBoothStatus();
  const [staleness, setStaleness] = useState(() => computeStaleness(lastStatusAt));

  useEffect(() => {
    setStaleness(computeStaleness(lastStatusAt));
    if (lastStatusAt === null) return undefined;
    const id = setInterval(() => {
      setStaleness(computeStaleness(lastStatusAt));
    }, 10_000);
    return () => clearInterval(id);
  }, [lastStatusAt]);

  return staleness;
}

export function BoothStatusBadge(): JSX.Element {
  const { status, runtimeMode } = useBoothStatus();
  const { level, label } = useStaleness();
  const badgeClass =
    level === "fresh"
      ? `booth-status-badge booth-status-badge--${status}`
      : `booth-status-badge booth-status-badge--${status} booth-status-badge--stale-${level}`;
  return (
    <div className={badgeClass} role="status">
      <span className="booth-status-badge__dot" aria-hidden="true" />
      <span>
        <span className="booth-status-badge__label">Booth status</span>
        <strong>{STATUS_LABELS[status]}</strong>
        {label !== null ? (
          <span className="booth-status-badge__staleness" aria-live="polite">
            {label}
          </span>
        ) : null}
      </span>
      <RuntimeModeBadge mode={runtimeMode} className="booth-status-badge__mode" nested />
    </div>
  );
}
