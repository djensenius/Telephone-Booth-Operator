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

// Providers that do the work off-box, driven by a push notification.
const PUSH_PROVIDERS = new Set(["push", "mac_app"]);

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
    return PUSH_PROVIDERS.has(transcription.provider)
      ? {
          label: "Waiting on transcription device",
          tone: "waiting",
          detail: `Queued for ${providerLabel(transcription)}`,
          canRetry: true,
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
