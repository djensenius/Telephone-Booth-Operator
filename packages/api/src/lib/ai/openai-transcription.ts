// OpenAI transcription provider. Downloads the audio blob from the SAS URL
// and POSTs it to `/v1/audio/transcriptions` as multipart/form-data.

import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./types.js";
import { ProviderError } from "./types.js";
import { DEFAULT_MAX_AUDIO_BYTES } from "./config.js";

export interface OpenAiTranscriptionOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxAudioBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxAudioBytes: number;

  constructor(opts: OpenAiTranscriptionOptions) {
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#maxAudioBytes = opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const audioResponse = await this.#fetch(input.audioUrl);
    if (!audioResponse.ok) {
      throw new ProviderError(this.name, "audio_fetch_failed", audioResponse.status);
    }

    const contentLength = Number(audioResponse.headers.get("content-length") ?? "0");
    if (contentLength > this.#maxAudioBytes) {
      // Abort the body to release the socket without buffering.
      await audioResponse.body?.cancel();
      throw new ProviderError(this.name, "audio_too_large");
    }

    const audioBytes = await audioResponse.arrayBuffer();
    if (audioBytes.byteLength > this.#maxAudioBytes) {
      throw new ProviderError(this.name, "audio_too_large");
    }
    const audioBlob = new Blob([audioBytes], { type: "audio/flac" });

    const body = new FormData();
    body.set("file", audioBlob, `${input.sha256}.flac`);
    body.set("model", this.model);
    body.set("response_format", "verbose_json");

    const response = await this.#fetch(`${this.#baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body,
    });
    if (!response.ok) {
      // Discard response body — never include upstream text in errors.
      await response.text().catch(() => "");
      throw new ProviderError(this.name, "transcription_failed", response.status);
    }
    const payload = (await response.json().catch(() => ({}))) as {
      text?: unknown;
      language?: unknown;
    };
    const text = typeof payload.text === "string" ? payload.text : "";
    const language = typeof payload.language === "string" ? payload.language : null;
    return { text, language };
  }
}
