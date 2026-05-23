import type { DebugConnectionChange } from "../../lib/debug-client.js";

export interface ConnectionStatusBarProps {
  readonly connection: DebugConnectionChange;
  readonly hasPrefs: boolean;
}

function transportLabel(value: DebugConnectionChange["transport"]): string {
  switch (value) {
    case "tailscale":
      return "Tailscale line";
    case "lan":
      return "LAN fallback";
    case "disconnected":
      return "Disconnected";
  }
}

export function ConnectionStatusBar({ connection, hasPrefs }: ConnectionStatusBarProps): JSX.Element {
  const latency = connection.latencyMs === null ? "—" : `${connection.latencyMs} ms`;
  return (
    <section className="debug-status-bar" aria-label="Phone client connection" aria-live="polite">
      <div>
        <span className={`debug-chip debug-chip--${connection.transport}`}>{hasPrefs ? transportLabel(connection.transport) : "Connection not configured"}</span>
      </div>
      <dl className="debug-status-bar__metrics">
        <div>
          <dt>Latency</dt>
          <dd>{latency}</dd>
        </div>
        <div>
          <dt>Telemetry socket</dt>
          <dd>{connection.wsState}</dd>
        </div>
      </dl>
      {connection.lastError === undefined ? null : <p className="debug-status-bar__error">Line is busy: {connection.lastError}</p>}
    </section>
  );
}
