import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";

export function StatusScreen(): JSX.Element {
  const { status, connectionStatus } = useBoothStatus();
  return (
    <GlassPanel title="Live status panel">
      <p className="screen-kicker">Digit 1</p>
      <h1>Live status</h1>
      <p>The operator console shell is connected to the booth visual system. Feature data lands in the next work item.</p>
      <dl className="status-grid">
        <div><dt>Booth state</dt><dd>{status}</dd></div>
        <div><dt>Line</dt><dd>{connectionStatus}</dd></div>
        <div><dt>Screen</dt><dd>Placeholder</dd></div>
      </dl>
    </GlassPanel>
  );
}
