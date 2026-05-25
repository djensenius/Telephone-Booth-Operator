import type { AudioMeter, BoothStatus } from "../../lib/debug-client.js";

export interface AudioPanelProps {
  readonly audio: AudioMeter | undefined;
  readonly status: BoothStatus | undefined;
}

function meterPercent(dbfs: number | undefined): number {
  if (dbfs === undefined || Number.isNaN(dbfs)) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((dbfs + 120) / 120) * 100));
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
  value,
}: {
  readonly label: string;
  readonly value: number | undefined;
}): JSX.Element {
  const display = value === undefined ? "—" : `${value.toFixed(1)} dBFS`;
  return (
    <div className="debug-meter">
      <div className="debug-meter__label">
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <div
        className="debug-meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={-120}
        aria-valuemax={0}
        aria-valuenow={value ?? -120}
      >
        <span className="debug-meter__fill" style={{ inlineSize: `${meterPercent(value)}%` }} />
      </div>
    </div>
  );
}

export function AudioPanel({ audio, status }: AudioPanelProps): JSX.Element {
  return (
    <section className="debug-panel" aria-labelledby="debug-audio-heading">
      <div className="debug-panel__heading">
        <p className="screen-kicker">Audio</p>
        <h2 id="debug-audio-heading">Handset meters</h2>
      </div>
      <Meter label="Input RMS" value={audio?.inputLevelDbfs} />
      <Meter label="Output RMS" value={audio?.outputLevelDbfs} />
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
