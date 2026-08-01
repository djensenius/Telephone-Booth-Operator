import type { BoothFanStats } from "@telephone-booth-operator/shared";
import type { CSSProperties, JSX } from "react";

interface FanVitalTileProps {
  readonly fan: BoothFanStats | null | undefined;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function FanVitalTile({ fan }: FanVitalTileProps): JSX.Element {
  const pwmRatio = typeof fan?.pwmRatio === "number" ? clampRatio(fan.pwmRatio) : null;
  const pwmPercent = pwmRatio == null ? null : Math.round(pwmRatio * 100);
  const needleDegrees = pwmRatio == null ? -90 : -90 + pwmRatio * 180;
  const measuredRpm = fan?.rpm;
  const command = fan?.commandedOn == null ? null : fan.commandedOn ? "On" : "Off";
  const value =
    measuredRpm != null
      ? measuredRpm.toLocaleString()
      : pwmPercent != null
        ? `${pwmPercent}%`
        : (command ?? "—");
  const meta =
    measuredRpm != null
      ? `RPM${pwmPercent != null ? ` · ${pwmPercent}% PWM` : command ? ` · ${command}` : ""}`
      : pwmPercent != null
        ? "PWM · no tach"
        : fan
          ? "No tach feedback"
          : "Awaiting telemetry";
  const state =
    fan?.coolingState != null
      ? fan.maxCoolingState != null
        ? `cooling state ${fan.coolingState}/${fan.maxCoolingState}`
        : `cooling state ${fan.coolingState}`
      : null;
  const descriptionParts = [
    measuredRpm != null ? `${measuredRpm} RPM measured` : null,
    pwmPercent != null ? `${pwmPercent}% PWM commanded` : null,
    pwmPercent == null && command ? `fan commanded ${command.toLowerCase()}` : null,
    fan && measuredRpm == null ? "no tachometer feedback" : null,
    state,
  ];
  const description = descriptionParts.filter((part): part is string => part != null).join(", ");
  const gaugeStyle = {
    "--fan-gauge-progress": `${(pwmRatio ?? 0) * 100}`,
    "--fan-gauge-needle": `${needleDegrees}deg`,
  } as CSSProperties;

  return (
    <div
      className="system-vitals-strip__tile system-vitals-strip__tile--fan"
      role="group"
      aria-label={`Cooling fan: ${description || "telemetry unavailable"}`}
      title={description || undefined}
    >
      <span className="system-vitals-strip__tile-label">Fan</span>
      <div className="fan-vital-tile__body">
        <svg className="fan-vital-tile__dial" viewBox="0 0 64 38" style={gaugeStyle} aria-hidden>
          <path className="fan-vital-tile__track" d="M 8 32 A 24 24 0 0 1 56 32" pathLength="100" />
          <path
            className="fan-vital-tile__progress"
            d="M 8 32 A 24 24 0 0 1 56 32"
            pathLength="100"
          />
          {pwmRatio != null ? (
            <line className="fan-vital-tile__needle" x1="32" y1="32" x2="32" y2="12" />
          ) : null}
          <circle className="fan-vital-tile__hub" cx="32" cy="32" r="3" />
        </svg>
        <div className="fan-vital-tile__readout">
          <span className="system-vitals-strip__tile-value">{value}</span>
          <span className="fan-vital-tile__meta">{meta}</span>
        </div>
      </div>
    </div>
  );
}
