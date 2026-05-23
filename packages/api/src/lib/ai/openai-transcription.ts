// OpenAI transcription provider. Downloads the audio blob from the SAS URL
// and POSTs it to `/v1/audio/transcriptions` as multipart/form-data.

import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAiTranscriptionOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAiTranscriptionOptions) {
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const audioResponse = await this.#fetch(input.audioUrl);
    if (!audioResponse.ok) {
      throw new ProviderError(this.name, `audio fetch failed: ${audioResponse.status}`, audioResponse.status);
    }
    const audioBytes = await audioResponse.arrayBuffer();
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
      const text = await response.text().catch(() => "");
      throw new ProviderError(this.name, `transcription failed: ${response.status} ${text.slice(0, 200)}`, response.status);
    }
    const payload = (await response.json().catch(() => ({}))) as { text?: unknown; language?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    const language = typeof payload.language === "string" ? payload.language : null;
    return { text, language };
  }
}
