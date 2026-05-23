import type { DebugClient } from "../../lib/debug-client.js";

export interface SimulatePanelProps {
  readonly allowControls: boolean;
  readonly client: DebugClient | null;
}

const PULSE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;

export function SimulatePanel({ allowControls, client }: SimulatePanelProps): JSX.Element | null {
  if (!allowControls) {
    return null;
  }

  return (
    <section className="debug-panel" aria-labelledby="debug-simulate-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">Controls</p>
        <h2 id="debug-simulate-heading">Simulate booth events</h2>
      </div>
      <div className="debug-button-row">
        <button type="button" onClick={() => void client?.simulateEvent({ event: "hook_off" })}>Simulate hook-off</button>
        <button type="button" onClick={() => void client?.simulateEvent({ event: "playback_ended" })}>Simulate playback complete</button>
        <button type="button" onClick={() => void client?.simulateEvent({ event: "hook_on" })}>Reset to Idle</button>
      </div>
      <div className="debug-pulse-buttons" aria-label="Pulse dial buttons">
        {PULSE_DIGITS.map((digit) => {
          const count = digit === 0 ? 10 : digit;
          return (
            <button key={digit} type="button" onClick={() => void client?.simulatePulse(count)}>
              Pulse {digit}
            </button>
          );
        })}
      </div>
    </section>
  );
}
