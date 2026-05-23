import { GlassPanel, useBoothStatus } from "../../components/booth/index.js";

export function SettingsScreen(): JSX.Element {
  const { muted, reducedMotionOverride, setMuted, setReducedMotionOverride } = useBoothStatus();
  return (
    <GlassPanel title="Operator settings">
      <p className="screen-kicker">Digit 6</p>
      <h1>Settings & tokens</h1>
      <p>Placeholder for API token CRUD and Authentik account details.</p>
      <div className="settings-list">
        <label>
          <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.currentTarget.checked)} />
          Mute booth sounds
        </label>
        <label>
          <input type="checkbox" checked={reducedMotionOverride} onChange={(event) => setReducedMotionOverride(event.currentTarget.checked)} />
          Allow spring motion and sounds when reduced motion is requested
        </label>
      </div>
    </GlassPanel>
  );
}
