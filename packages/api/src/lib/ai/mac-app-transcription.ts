// Mac-app stub. POSTs the SAS audio URL + metadata to a local HTTP service
// (the upstream Hummingbird app in ../Telephone-Booth-Transcription) and
// expects a JSON response `{ text: string, language?: string }`.
//
// The exact contract is documented in `docs/transcription-providers.md`.
// Until the Mac app implements the endpoint this provider returns a clear
// `ProviderError` so the pipeline records a failure attempt.

import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface MacAppTranscriptionOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
}

export class MacAppTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mac_app" as const;
  readonly model: string;
  readonly #url: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;

  constructor(opts: MacAppTranscriptionOptions) {
    this.model = opts.model ?? "mac-app";
    this.#url = opts.url;
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      body: JSON.stringify({
        audioUrl: input.audioUrl,
        sha256: input.sha256,
        durationMs: input.durationMs,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(this.name, `mac-app transcription failed: ${response.status} ${text.slice(0, 200)}`, response.status);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    const data = (typeof payload === "object" && payload !== null ? payload : {}) as { text?: unknown; language?: unknown };
    if (typeof data.text !== "string" || data.text.length === 0) {
      throw new ProviderError(this.name, "mac-app transcription returned no text");
    }
    return { text: data.text, language: typeof data.language === "string" ? data.language : null };
  }
}
