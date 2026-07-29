import type { JSX } from "react";
import type { BoothStatus } from "../../lib/debug-client.js";
import { METER_FLOOR_DBFS, meterPercent } from "./audio-meters.js";
import type { ResolvedMeter } from "./audio-meters.js";

/** The non-level fields of the booth's audio snapshot. */
export interface AudioDeviceInfo {
  readonly currentDevice: string | null;
  readonly sampleRateHz: number | null;
  readonly updatedAt: string | null;
}

export interface AudioPanelProps {
  readonly audio: AudioDeviceInfo | undefined;
  readonly input: ResolvedMeter;
  readonly output: ResolvedMeter;
  readonly status: BoothStatus | undefined;
}

function recordingDuration(status: BoothStatus | undefined): string {
  if (status?.state !== "recording") {
    return "not recording";
  }
  const started = Date.parse(status.updatedAt);
  if (Number.isNaN(started)) {
    return "recording";
  }
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return `${seconds}s`;
}

function Meter({
  label,
  meter,
}: {
  readonly label: string;
  readonly meter: ResolvedMeter;
}): JSX.Element {
  if (meter.stale) {
    return (
      <div className="debug-meter debug-meter--stale">
        <div className="debug-meter__label">
          <span>{label}</span>
          <span>— dBFS</span>
        </div>
        {/* A stale meter must not render as an empty bar, or a dropped
            connection would be indistinguishable from a silent booth. */}
        <div className="debug-meter__track" aria-hidden="true">
          <span className="debug-meter__fill debug-meter__fill--stale" />
        </div>
        <p className="debug-meter__note">{label}: no recent samples</p>
      </div>
    );
  }

  const level = meter.levelDbfs ?? METER_FLOOR_DBFS;
  return (
    <div className="debug-meter">
      <div className="debug-meter__label">
        <span>{label}</span>
        <span>
          {level.toFixed(1)} dBFS
          {meter.peakDbfs === undefined ? null : ` · peak ${meter.peakDbfs.toFixed(1)}`}
        </span>
      </div>
      <div
        className="debug-meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={METER_FLOOR_DBFS}
        aria-valuemax={0}
        aria-valuenow={level}
      >
        <span className="debug-meter__fill" style={{ inlineSize: `${meterPercent(level)}%` }} />
        {meter.peakDbfs === undefined ? null : (
          <span
            className="debug-meter__peak"
            style={{ insetInlineStart: `${meterPercent(meter.peakDbfs)}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function AudioPanel({ audio, input, output, status }: AudioPanelProps): JSX.Element {
  return (
    <section className="debug-panel" aria-labelledby="debug-audio-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">Audio</p>
        <h2 id="debug-audio-heading">Handset meters</h2>
      </div>
      <Meter label="Input RMS" meter={input} />
      <Meter label="Output RMS" meter={output} />
      <dl className="debug-kv-grid debug-kv-grid--compact">
        <div>
          <dt>Device</dt>
          <dd>{audio?.currentDevice ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Sample rate</dt>
          <dd>
            {audio?.sampleRateHz === null || audio?.sampleRateHz === undefined
              ? "—"
              : `${audio.sampleRateHz} Hz`}
          </dd>
        </div>
        <div>
          <dt>Recording duration</dt>
          <dd>{recordingDuration(status)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{audio?.updatedAt ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
