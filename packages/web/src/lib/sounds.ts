import { getReducedMotionPreference } from "./motion.js";

export type SoundName = "dial-click" | "dial-tone" | "ring" | "line-busy" | "handset-pickup";

const soundUrls: Record<SoundName, string> = {
  "dial-click": new URL("../sounds/dial-click.flac", import.meta.url).href,
  "dial-tone": new URL("../sounds/dial-tone.flac", import.meta.url).href,
  "ring": new URL("../sounds/ring.flac", import.meta.url).href,
  "line-busy": new URL("../sounds/line-busy.flac", import.meta.url).href,
  "handset-pickup": new URL("../sounds/handset-pickup.flac", import.meta.url).href,
};

const pools = new Map<SoundName, HTMLAudioElement[]>();

function canUseAudio(): boolean {
  return typeof Audio !== "undefined";
}

function getPool(name: SoundName): HTMLAudioElement[] {
  const existing = pools.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const created = Array.from({ length: 4 }, () => {
    const audio = new Audio(soundUrls[name]);
    audio.preload = "auto";
    return audio;
  });
  pools.set(name, created);
  return created;
}

export interface PlaySoundOptions {
  readonly muted: boolean;
  readonly allowReducedMotionAudio: boolean;
}

export function playSound(name: SoundName, options: PlaySoundOptions): void {
  if (options.muted || !canUseAudio()) {
    return;
  }
  if (getReducedMotionPreference() && !options.allowReducedMotionAudio) {
    return;
  }
  const candidate = getPool(name).find((audio) => audio.paused || audio.ended) ?? getPool(name)[0];
  if (candidate === undefined) {
    return;
  }
  candidate.currentTime = 0;
  void candidate.play().catch(() => undefined);
}

export function playDialClicks(steps: number, options: PlaySoundOptions): void {
  if (steps <= 0 || options.muted || (getReducedMotionPreference() && !options.allowReducedMotionAudio)) {
    return;
  }
  for (let step = 0; step < steps; step += 1) {
    window.setTimeout(() => playSound("dial-click", options), step * 60);
  }
}
