// Shared, push-aware presentation of a transcription's state.
//
// When `AI_TRANSCRIPTION_PROVIDER=push` (see docs/transcription-providers.md)
// the API does not transcribe in-process: it writes a `pending` row and
// broadcasts a `work` envelope so the Transcription app picks the job up and
// posts the text back. "Transcribing…" is misleading there — nothing is
// running on the server — so pending push work reads as waiting on a device.
//
// Failures likewise deserve their reason: a `failed` row can mean the provider
// is disabled, the audio was too large, the pending row went stale, or the
// device reported an error. The queue used to flatten all of that into a bare
// "Transcription failed".

import type { Transcription } from "@telephone-booth-operator/shared";

export type TranscriptionTone = "waiting" | "pending" | "failed" | "ok" | "none";

export interface TranscriptionStatusView {
  readonly label: string;
  readonly tone: TranscriptionTone;
  /** Human-readable extra context (provider, error). `null` when there is none. */
  readonly detail: string | null;
  readonly canRetry: boolean;
}

// Providers whose work happens off-box. Both are driven by a device rather
// than by the API process, but only `push` is safe to re-request while a row
// is pending: `push` rebroadcasts the work envelope, whereas an in-process
// provider like `mac_app` is already awaiting its own HTTP call and answers a
// second request with `409 transcription_already_pending`.
const DEVICE_PROVIDERS = new Set(["push", "mac_app"]);
const REBROADCASTABLE_PROVIDERS = new Set(["push"]);

function providerLabel(transcription: Transcription): string {
  return transcription.model
    ? `${transcription.provider} · ${transcription.model}`
    : transcription.provider;
}

export function transcriptionStatusView(
  transcription: Transcription | null | undefined,
): TranscriptionStatusView {
  if (!transcription) {
    return { label: "No transcription yet", tone: "none", detail: null, canRetry: true };
  }
  if (transcription.status === "pending") {
    return DEVICE_PROVIDERS.has(transcription.provider)
      ? {
          label: "Waiting on transcription device",
          tone: "waiting",
          detail: `Queued for ${providerLabel(transcription)}`,
          canRetry: REBROADCASTABLE_PROVIDERS.has(transcription.provider),
        }
      : { label: "Transcribing…", tone: "pending", detail: null, canRetry: false };
  }
  if (transcription.status === "failed") {
    const reason = transcription.error?.trim();
    return {
      label: "Transcription failed",
      tone: "failed",
      detail:
        reason && reason.length > 0
          ? `${reason} (${providerLabel(transcription)})`
          : providerLabel(transcription),
      canRetry: true,
    };
  }
  // A succeeded transcription with no words is a silent recording, which is a
  // meaningful review signal — don't collapse it into a generic status line.
  if (transcriptText(transcription) === null) {
    return { label: "Silence", tone: "none", detail: null, canRetry: true };
  }
  return { label: "Transcribed", tone: "ok", detail: null, canRetry: true };
}

const SNIPPET_CHARS = 140;

/**
 * Text an operator should read for moderation: the translation when one
 * succeeded, otherwise the original. Empty transcripts mean silence.
 */
export function transcriptText(transcription: Transcription | null | undefined): string | null {
  if (!transcription || transcription.status !== "succeeded") return null;
  const candidate =
    transcription.translationStatus === "succeeded" &&
    typeof transcription.translatedText === "string" &&
    transcription.translatedText.trim().length > 0
      ? transcription.translatedText
      : transcription.text;
  const text = candidate?.replace(/\s+/g, " ").trim() ?? "";
  return text.length === 0 ? null : text;
}

export function transcriptSnippet(text: string): {
  readonly snippet: string;
  readonly truncated: boolean;
} {
  return text.length <= SNIPPET_CHARS
    ? { snippet: text, truncated: false }
    : { snippet: `${text.slice(0, SNIPPET_CHARS - 1)}…`, truncated: true };
}
