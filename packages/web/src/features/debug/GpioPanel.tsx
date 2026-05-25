import type { GpioSnapshot, PinRole } from "../../lib/debug-client.js";

export interface PulseAccumulator {
  readonly currentCount: number;
  readonly lastDigit: number | null;
  readonly lastPulseCount: number | null;
}

export interface GpioPanelProps {
  readonly snapshot: GpioSnapshot | undefined;
  readonly pulseAccumulator: PulseAccumulator;
  readonly pinLabels: ReadonlyMap<string, string>;
}

function roleLabel(role: PinRole): string {
  return role.replaceAll("_", " ");
}

function pinLabel(role: PinRole, pinLabels: ReadonlyMap<string, string>): string {
  return pinLabels.get(role) ?? "Not listed in config";
}

export function GpioPanel({ snapshot, pulseAccumulator, pinLabels }: GpioPanelProps): JSX.Element {
  const pins = snapshot?.pins ?? [];
  return (
    <section className="debug-panel" aria-labelledby="debug-gpio-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">GPIO</p>
        <h2 id="debug-gpio-heading">Pin board</h2>
      </div>
      <div className="debug-pulse-card" aria-label="Rotary pulse accumulator">
        <span>Current pulse group</span>
        <strong>{pulseAccumulator.currentCount}</strong>
        <span>
          Last decoded: {pulseAccumulator.lastDigit === null ? "none" : pulseAccumulator.lastDigit}{" "}
          ({pulseAccumulator.lastPulseCount ?? 0} pulses)
        </span>
      </div>
      <div className="debug-table-wrap" tabIndex={0} aria-label="GPIO pin states">
        <table className="debug-table">
          <caption>Live GPIO pin states</caption>
          <thead>
            <tr>
              <th scope="col">Pin role</th>
              <th scope="col">BCM label</th>
              <th scope="col">Level</th>
              <th scope="col">Last edge</th>
            </tr>
          </thead>
          <tbody>
            {pins.length === 0 ? (
              <tr>
                <td colSpan={4}>No GPIO sample received.</td>
              </tr>
            ) : (
              pins.map((pin) => (
                <tr key={pin.role}>
                  <th scope="row">{roleLabel(pin.role)}</th>
                  <td>{pinLabel(pin.role, pinLabels)}</td>
                  <td>
                    <span className={`debug-level debug-level--${pin.level ? "high" : "low"}`}>
                      {pin.level ? "high" : "low"}
                    </span>
                  </td>
                  <td>{pin.lastEdgeMonotonicNs.toLocaleString()} ns</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="debug-updated">Newest GPIO edge: {snapshot?.updatedAt ?? "—"}</p>
    </section>
  );
}
