import { GlassPanel } from "../../components/booth/index.js";

export function DebugScreen(): JSX.Element {
  return (
    <GlassPanel title="Phone-booth debug surface">
      <p className="screen-kicker">Digit 9</p>
      <h1>Debug</h1>
      <p>Placeholder for LAN, Tailscale, and multi-booth diagnostics.</p>
      <pre className="terminal-card">booth.link = awaiting telemetry</pre>
    </GlassPanel>
  );
}
