import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { AudioPanel } from "./AudioPanel.js";
import { EMPTY_AUDIO_METERS, recordSample, resolveMeter } from "./audio-meters.js";

const device = {
  currentDevice: "USB handset",
  sampleRateHz: 48000,
  updatedAt: "2026-01-01T00:00:02Z",
};

const staleMeter = resolveMeter(EMPTY_AUDIO_METERS, "input", 0);

describe("AudioPanel", () => {
  it("renders the level and held peak for a fresh meter", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "output", {
      levelDbfs: -12,
      peakDbfs: -3,
      receivedAt: 1_000,
      staleAfterMs: 500,
    });
    render(
      <AudioPanel
        audio={device}
        input={staleMeter}
        output={resolveMeter(state, "output", 1_100)}
        status={undefined}
      />,
    );

    expect(screen.getByText(/-12\.0 dBFS/)).toBeTruthy();
    expect(screen.getByText(/peak -3\.0/)).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Output RMS" }).getAttribute("aria-valuenow")).toBe(
      "-12",
    );
  });

  it("shows a stale meter as having no recent samples rather than a frozen level", () => {
    const state = recordSample(EMPTY_AUDIO_METERS, "output", {
      levelDbfs: -12,
      peakDbfs: -3,
      receivedAt: 1_000,
      staleAfterMs: 500,
    });
    render(
      <AudioPanel
        audio={device}
        input={staleMeter}
        output={resolveMeter(state, "output", 5_000)}
        status={undefined}
      />,
    );

    expect(screen.queryByText(/-12\.0 dBFS/)).toBeNull();
    expect(screen.getByText("Output RMS: no recent samples")).toBeTruthy();
    expect(screen.getByText("Input RMS: no recent samples")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("does not render a stale meter as an empty bar", () => {
    const { container } = render(
      <AudioPanel audio={device} input={staleMeter} output={staleMeter} status={undefined} />,
    );

    const fills = container.querySelectorAll(".debug-meter__fill--stale");
    expect(fills).toHaveLength(2);
    for (const fill of fills) {
      expect((fill as HTMLElement).style.inlineSize).toBe("");
    }
  });
});
