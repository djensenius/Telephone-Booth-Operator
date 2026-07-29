/**
 * Meter ballistics and staleness bookkeeping for the debug audio panel.
 *
 * The booth can stop sending `audio_level` telemetry at any time — playback
 * ends, the socket drops, the poll stalls. The client can never prove the booth
 * is alive, so sample age is tracked locally and a meter that has gone quiet is
 * reported as stale rather than being left frozen at its last value.
 */

export const METER_FLOOR_DBFS = -120;

/** Live telemetry arrives at ~20 Hz, so half a second is comfortably a gap. */
export const LIVE_SAMPLE_STALE_AFTER_MS = 500;

/** REST fallback polls every 2s; allow one missed poll before going stale. */
export const POLLED_SAMPLE_STALE_AFTER_MS = 3_000;

export const PEAK_HOLD_MS = 1_000;
export const PEAK_DECAY_DB_PER_SECOND = 12;

/** Cadence of the render ticker that drives staleness and peak decay. */
export const METER_TICK_MS = 100;

export type AudioChannel = "input" | "output";

export const AUDIO_CHANNELS: readonly AudioChannel[] = ["input", "output"];

export interface ChannelSample {
  readonly levelDbfs: number;
  readonly peakDbfs: number;
  /** Local receive time, so booth clock skew cannot fake a fresh sample. */
  readonly receivedAt: number;
  readonly peakSetAt: number;
  readonly staleAfterMs: number;
}

export type AudioMeterState = {
  readonly [channel in AudioChannel]: ChannelSample | undefined;
};

export const EMPTY_AUDIO_METERS: AudioMeterState = {
  input: undefined,
  output: undefined,
};

export interface ResolvedMeter {
  readonly stale: boolean;
  readonly levelDbfs: number | undefined;
  readonly peakDbfs: number | undefined;
}

const STALE_METER: ResolvedMeter = {
  stale: true,
  levelDbfs: undefined,
  peakDbfs: undefined,
};

export function dbfsFromLinear(value: number): number {
  return Math.max(METER_FLOOR_DBFS, 20 * Math.log10(Math.max(value, 0.000001)));
}

function heldPeakDbfs(sample: ChannelSample, now: number): number {
  const elapsed = now - sample.peakSetAt;
  if (elapsed <= PEAK_HOLD_MS) {
    return sample.peakDbfs;
  }
  const decayed = sample.peakDbfs - ((elapsed - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_DB_PER_SECOND;
  return Math.max(METER_FLOOR_DBFS, decayed);
}

export interface SampleInput {
  readonly levelDbfs: number;
  readonly peakDbfs: number;
  readonly receivedAt: number;
  readonly staleAfterMs: number;
}

/**
 * Fold a new sample into a channel, holding the peak when the incoming peak is
 * lower than the value currently being held.
 */
export function recordSample(
  state: AudioMeterState,
  channel: AudioChannel,
  input: SampleInput,
): AudioMeterState {
  const previous = state[channel];
  const level = Math.max(METER_FLOOR_DBFS, input.levelDbfs);
  const peak = Math.max(METER_FLOOR_DBFS, input.peakDbfs, level);
  const held = previous === undefined ? METER_FLOOR_DBFS : heldPeakDbfs(previous, input.receivedAt);

  let peakDbfs = peak;
  let peakSetAt = input.receivedAt;
  if (previous !== undefined && held > peak) {
    peakDbfs = held;
    peakSetAt =
      input.receivedAt - previous.peakSetAt <= PEAK_HOLD_MS
        ? // Still inside the hold window: keep the original hold start.
          previous.peakSetAt
        : // Already decaying: rebase so the peak keeps falling instead of
          // restarting its hold on every incoming sample.
          input.receivedAt - PEAK_HOLD_MS;
  }

  const sample: ChannelSample = {
    levelDbfs: level,
    peakDbfs,
    receivedAt: input.receivedAt,
    peakSetAt,
    staleAfterMs: input.staleAfterMs,
  };

  return { ...state, [channel]: sample };
}

export type PolledMeterIdentities = {
  readonly [channel in AudioChannel]: string | null;
};

export const NO_POLLED_IDENTITIES: PolledMeterIdentities = {
  input: null,
  output: null,
};

export interface PolledAudioSnapshot {
  readonly inputLevelDbfs: number;
  readonly outputLevelDbfs: number;
  readonly inputPeakDbfs: number;
  readonly outputPeakDbfs: number;
}

function channelLevel(snapshot: PolledAudioSnapshot, channel: AudioChannel): number {
  return channel === "input" ? snapshot.inputLevelDbfs : snapshot.outputLevelDbfs;
}

function channelPeak(snapshot: PolledAudioSnapshot, channel: AudioChannel): number {
  return channel === "input" ? snapshot.inputPeakDbfs : snapshot.outputPeakDbfs;
}

/**
 * Per-channel sample identity for a polled `/v1/audio` snapshot.
 *
 * The snapshot carries both channels and a single shared timestamp, so it
 * changes whenever *either* channel moves. Recording both channels from it
 * would let an active output keep a stopped input looking fresh forever, so a
 * channel counts as a new sample only when its own values changed. The shared
 * timestamp is deliberately excluded for the same reason.
 *
 * A channel repeating an identical level and peak therefore reads as stale.
 * That is the conservative direction: over REST a repeated value genuinely is
 * indistinguishable from a stopped feed, and the booth reporting silence
 * explicitly is what djensenius/Telephone-Booth#133 addresses.
 */
export function polledIdentities(snapshot: PolledAudioSnapshot): PolledMeterIdentities {
  return {
    input: `${snapshot.inputLevelDbfs}|${snapshot.inputPeakDbfs}`,
    output: `${snapshot.outputLevelDbfs}|${snapshot.outputPeakDbfs}`,
  };
}

/** Channels whose sample identity differs from the last recorded snapshot. */
export function changedPolledChannels(
  previous: PolledMeterIdentities,
  next: PolledMeterIdentities,
): readonly AudioChannel[] {
  return AUDIO_CHANNELS.filter((channel) => previous[channel] !== next[channel]);
}

export function recordPolledSnapshot(
  state: AudioMeterState,
  snapshot: PolledAudioSnapshot,
  channels: readonly AudioChannel[],
  receivedAt: number,
): AudioMeterState {
  return channels.reduce(
    (meters, channel) =>
      recordSample(meters, channel, {
        levelDbfs: channelLevel(snapshot, channel),
        peakDbfs: channelPeak(snapshot, channel),
        receivedAt,
        staleAfterMs: POLLED_SAMPLE_STALE_AFTER_MS,
      }),
    state,
  );
}

export function resolveMeter(
  state: AudioMeterState,
  channel: AudioChannel,
  now: number,
): ResolvedMeter {
  const sample = state[channel];
  if (sample === undefined || now - sample.receivedAt >= sample.staleAfterMs) {
    return STALE_METER;
  }
  return {
    stale: false,
    levelDbfs: sample.levelDbfs,
    peakDbfs: Math.max(sample.levelDbfs, heldPeakDbfs(sample, now)),
  };
}

export function meterPercent(dbfs: number | undefined): number {
  if (dbfs === undefined || Number.isNaN(dbfs)) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS) * 100));
}

/**
 * Milliseconds until the meters would next render differently, or `null` when
 * they have settled and no further re-render is needed. Lets the panel wake up
 * only for a staleness transition or a peak-decay frame.
 */
export function nextMeterUpdateDelay(state: AudioMeterState, now: number): number | null {
  let next: number | null = null;
  for (const channel of AUDIO_CHANNELS) {
    const sample = state[channel];
    if (sample === undefined) {
      continue;
    }
    const staleAt = sample.receivedAt + sample.staleAfterMs;
    if (now >= staleAt) {
      continue;
    }
    const decayStart = sample.peakSetAt + PEAK_HOLD_MS;
    let candidate = staleAt;
    if (now < decayStart) {
      candidate = Math.min(decayStart, staleAt);
    } else if (heldPeakDbfs(sample, now) > sample.levelDbfs) {
      candidate = Math.min(now + METER_TICK_MS, staleAt);
    }
    next = next === null ? candidate : Math.min(next, candidate);
  }
  return next === null ? null : Math.max(0, next - now);
}
