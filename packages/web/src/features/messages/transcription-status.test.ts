import { describe, expect, it } from "vite-plus/test";
import type { Transcription } from "@telephone-booth-operator/shared";
import {
  transcriptSnippet,
  transcriptText,
  transcriptionStatusView,
} from "./transcription-status.js";

const base: Transcription = {
  id: "55555555-5555-4555-8555-555555555555",
  messageId: "22222222-2222-4222-8222-222222222222",
  provider: "openai",
  model: null,
  status: "succeeded",
  text: "hello  from   the booth",
  language: "en",
  durationMs: 9000,
  latencyMs: null,
  error: null,
  requestedById: null,
  createdAt: "2026-01-02T00:02:00.000Z",
  completedAt: "2026-01-02T00:02:30.000Z",
  translationStatus: null,
  translatedText: null,
  translatedLanguage: null,
  translationProvider: null,
  translationModel: null,
  translationError: null,
  translationLatencyMs: null,
  translationCompletedAt: null,
};

describe("transcriptionStatusView", () => {
  it("treats a pending push job as waiting on a device, not as work in progress", () => {
    const view = transcriptionStatusView({ ...base, provider: "push", status: "pending" });
    expect(view.label).toBe("Waiting on transcription device");
    expect(view.tone).toBe("waiting");
    expect(view.detail).toBe("Queued for push");
  });

  it("treats a pending mac_app job the same way", () => {
    expect(transcriptionStatusView({ ...base, provider: "mac_app", status: "pending" }).tone).toBe(
      "waiting",
    );
  });

  it("shows in-process providers as transcribing", () => {
    const view = transcriptionStatusView({ ...base, status: "pending" });
    expect(view.label).toBe("Transcribing…");
    expect(view.canRetry).toBe(false);
  });

  it("surfaces the failure reason and provider", () => {
    const view = transcriptionStatusView({
      ...base,
      status: "failed",
      model: "whisper-1",
      error: "audio too large",
    });
    expect(view.label).toBe("Transcription failed");
    expect(view.detail).toBe("audio too large (openai · whisper-1)");
    expect(view.canRetry).toBe(true);
  });

  it("falls back to the provider when a failure carries no reason", () => {
    expect(transcriptionStatusView({ ...base, status: "failed" }).detail).toBe("openai");
  });

  it("reports when nothing has been transcribed yet", () => {
    expect(transcriptionStatusView(null).tone).toBe("none");
  });
});

describe("transcriptText", () => {
  it("collapses whitespace in the original text", () => {
    expect(transcriptText(base)).toBe("hello from the booth");
  });

  it("prefers a succeeded translation", () => {
    expect(
      transcriptText({
        ...base,
        translationStatus: "succeeded",
        translatedText: "bonjour de la cabine",
      }),
    ).toBe("bonjour de la cabine");
  });

  it("ignores a translation that has not succeeded", () => {
    expect(
      transcriptText({ ...base, translationStatus: "failed", translatedText: "partial" }),
    ).toBe("hello from the booth");
  });

  it("returns null for silence and for unfinished transcriptions", () => {
    expect(transcriptText({ ...base, text: "   " })).toBeNull();
    expect(transcriptText({ ...base, status: "pending" })).toBeNull();
  });
});

describe("transcriptSnippet", () => {
  it("leaves short text alone", () => {
    expect(transcriptSnippet("short")).toEqual({ snippet: "short", truncated: false });
  });

  it("truncates long text with an ellipsis", () => {
    const result = transcriptSnippet("x".repeat(200));
    expect(result.truncated).toBe(true);
    expect(result.snippet).toHaveLength(140);
    expect(result.snippet.endsWith("…")).toBe(true);
  });
});
