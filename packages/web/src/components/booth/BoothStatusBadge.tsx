import { useBoothStatus } from "./BoothStatusContext.js";
import type { BoothDisplayStatus } from "./BoothStatusContext.js";
import { RuntimeModeBadge } from "./RuntimeModeBadge.js";

const STATUS_LABELS = {
  idle: "Idle",
  playing: "Playing",
  recording: "Recording",
  error: "Error",
} satisfies Record<BoothDisplayStatus, string>;

export function BoothStatusBadge(): JSX.Element {
  const { status, runtimeMode } = useBoothStatus();
  return (
    <div className={`booth-status-badge booth-status-badge--${status}`} role="status">
      <span className="booth-status-badge__dot" aria-hidden="true" />
      <span>
        <span className="booth-status-badge__label">Booth status</span>
        <strong>{STATUS_LABELS[status]}</strong>
      </span>
      <RuntimeModeBadge mode={runtimeMode} className="booth-status-badge__mode" />
    </div>
  );
}
