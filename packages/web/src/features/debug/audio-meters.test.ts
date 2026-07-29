import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_AUDIO_METERS,
  LIVE_SAMPLE_STALE_AFTER_MS,
  METER_FLOOR_DBFS,
  METER_TICK_MS,
  PEAK_DECAY_DB_PER_SECOND,
  PEAK_HOLD_MS,
  dbfsFromLinear,
  meterPercent,
  nextMeterUpdateDelay,
  recordSample,
  resolveMeter,
} from "./audio-meters.js";

const base = { staleAfterMs: LIVE_SAMPLE_STALE_AFTER_MS };

describe("audio meter ballistics", () => {
  it("reports a channel with no samples as stale", () => {
    expect(resolveMeter(EMPTY_AUDIO_METERS, "input", 1_000)).toEqual({
      stale: true,
      levelDbfs: undefined,
      peakDbfs: undefined,
    });
  });

  it("reports a fresh sample with its level", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "output", {
      ...base,
      levelDbfs: -12,
      peakDbfs: -3,
      receivedAt: 1_000,
    });
    const meter = resolveMeter(state, "output", 1_100);
    expect(meter.stale).toBe(false);
    expect(meter.levelDbfs).toBe(-12);
    expect(meter.peakDbfs).toBe(-3);
  });

  it("goes stale once telemetry stops instead of freezing at the last level", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "output", {
      ...base,
      levelDbfs: -12,
      peakDbfs: -3,
      receivedAt: 1_000,
    });
    expect(resolveMeter(state, "output", 1_000 + LIVE_SAMPLE_STALE_AFTER_MS)).toEqual({
      stale: true,
      levelDbfs: undefined,
      peakDbfs: undefined,
    });
  });

  it("tracks staleness per channel", () => {
    const withInput = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -20,
      peakDbfs: -20,
      receivedAt: 0,
    });
    const state = recordSample(withInput, "output", {
      ...base,
      levelDbfs: -6,
      peakDbfs: -6,
      receivedAt: 1_000,
    });
    expect(resolveMeter(state, "input", 1_100).stale).toBe(true);
    expect(resolveMeter(state, "output", 1_100).stale).toBe(false);
  });

  it("holds the peak while newer samples are quieter", () => {
    const loud = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -6,
      peakDbfs: -3,
      receivedAt: 1_000,
    });
    const quiet = recordSample(loud, "input", {
      ...base,
      levelDbfs: -40,
      peakDbfs: -38,
      receivedAt: 1_200,
    });
    const meter = resolveMeter(quiet, "input", 1_250);
    expect(meter.levelDbfs).toBe(-40);
    expect(meter.peakDbfs).toBe(-3);
  });

  it("decays the held peak after the hold window", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -60,
      peakDbfs: -3,
      receivedAt: 0,
      staleAfterMs: 10_000,
    });
    expect(resolveMeter(state, "input", PEAK_HOLD_MS).peakDbfs).toBe(-3);
    const meter = resolveMeter(state, "input", PEAK_HOLD_MS + 500);
    expect(meter.peakDbfs).toBeCloseTo(-3 - PEAK_DECAY_DB_PER_SECOND * 0.5, 5);
  });

  it("keeps a decaying peak falling across quieter samples", () => {
    const loud = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -6,
      peakDbfs: -3,
      receivedAt: 0,
      staleAfterMs: 10_000,
    });
    const quiet = recordSample(loud, "input", {
      ...base,
      levelDbfs: -60,
      peakDbfs: -58,
      receivedAt: PEAK_HOLD_MS + 1_000,
      staleAfterMs: 10_000,
    });
    const atSample = resolveMeter(quiet, "input", PEAK_HOLD_MS + 1_000);
    const later = resolveMeter(quiet, "input", PEAK_HOLD_MS + 2_000);
    expect(atSample.peakDbfs).toBeCloseTo(-3 - PEAK_DECAY_DB_PER_SECOND, 5);
    expect(later.peakDbfs).toBeCloseTo(-3 - PEAK_DECAY_DB_PER_SECOND * 2, 5);
  });

  it("never reports a peak below the current level", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -10,
      peakDbfs: -30,
      receivedAt: 0,
    });
    expect(resolveMeter(state, "input", 0).peakDbfs).toBe(-10);
  });

  it("clamps levels and peaks to the meter floor", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "input", {
      ...base,
      levelDbfs: -500,
      peakDbfs: -500,
      receivedAt: 0,
    });
    expect(resolveMeter(state, "input", 0).levelDbfs).toBe(METER_FLOOR_DBFS);
  });

  it("converts linear amplitude to dBFS with a floor", () => {
    expect(dbfsFromLinear(1)).toBeCloseTo(0, 5);
    expect(dbfsFromLinear(0)).toBe(METER_FLOOR_DBFS);
  });

  it("maps dBFS onto the bar width", () => {
    expect(meterPercent(0)).toBe(100);
    expect(meterPercent(METER_FLOOR_DBFS)).toBe(0);
    expect(meterPercent(undefined)).toBe(0);
  });

  describe("update scheduling", () => {
    it("needs no wake-up when there are no samples", () => {
      expect(nextMeterUpdateDelay(EMPTY_AUDIO_METERS, 0)).toBeNull();
    });

    it("settles once every channel is stale", () => {
      const state = recordSample(EMPTY_AUDIO_METERS, "input", {
        ...base,
        levelDbfs: -12,
        peakDbfs: -3,
        receivedAt: 0,
      });
      expect(nextMeterUpdateDelay(state, LIVE_SAMPLE_STALE_AFTER_MS)).toBeNull();
    });

    it("wakes at the staleness boundary while the peak is still held", () => {
      const state = recordSample(EMPTY_AUDIO_METERS, "input", {
        ...base,
        levelDbfs: -12,
        peakDbfs: -3,
        receivedAt: 0,
      });
      expect(nextMeterUpdateDelay(state, 0)).toBe(LIVE_SAMPLE_STALE_AFTER_MS);
    });

    it("wakes each frame while the peak is decaying", () => {
      const state = recordSample(EMPTY_AUDIO_METERS, "input", {
        ...base,
        levelDbfs: -60,
        peakDbfs: -3,
        receivedAt: 0,
        staleAfterMs: 10_000,
      });
      expect(nextMeterUpdateDelay(state, 0)).toBe(PEAK_HOLD_MS);
      expect(nextMeterUpdateDelay(state, PEAK_HOLD_MS + 10)).toBe(METER_TICK_MS);
    });
  });
});
