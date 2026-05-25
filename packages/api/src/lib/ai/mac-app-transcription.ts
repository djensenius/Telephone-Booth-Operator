// Mac-app transcription provider. Downloads the audio blob from the SAS URL
// and POSTs it to the Transcription macOS app's OpenAI-compatible endpoint.

import { DEFAULT_MAX_AUDIO_BYTES } from "./config.js";
import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface MacAppTranscriptionOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
  readonly maxAudioBytes?: number;
}

const transcriptionPath = "/v1/audio/transcriptions";

const endpointFromUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(transcriptionPath)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/audio/transcriptions`;
  return `${trimmed}${transcriptionPath}`;
};

export class MacAppTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mac_app" as const;
  readonly model: string;
  readonly #endpoint: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #upstreamModel: string | null;
  readonly #maxAudioBytes: number;

  constructor(opts: MacAppTranscriptionOptions) {
    this.model = opts.model ?? "mac-app";
    this.#endpoint = endpointFromUrl(opts.url);
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#upstreamModel = opts.model ?? null;
    this.#maxAudioBytes = opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    let audioResponse: Response;
    try {
      audioResponse = await this.#fetch(input.audioUrl);
    } catch {
      throw new ProviderError(this.name, "audio_fetch_failed");
    }
    if (!audioResponse.ok) {
      await audioResponse.body?.cancel();
      throw new ProviderError(this.name, "audio_fetch_failed", audioResponse.status);
    }

    const contentLength = Number(audioResponse.headers.get("content-length") ?? "0");
    if (contentLength > this.#maxAudioBytes) {
      await audioResponse.body?.cancel();
      throw new ProviderError(this.name, "audio_too_large");
    }

    let audioBytes: ArrayBuffer;
    try {
      audioBytes = await audioResponse.arrayBuffer();
    } catch {
      throw new ProviderError(this.name, "audio_fetch_failed");
    }
    if (audioBytes.byteLength > this.#maxAudioBytes) {
      throw new ProviderError(this.name, "audio_too_large");
    }
    const audioBlob = new Blob([audioBytes], { type: "audio/flac" });

    const body = new FormData();
    body.set("file", audioBlob, `${input.sha256}.flac`);
    if (this.#upstreamModel) body.set("model", this.#upstreamModel);
    body.set("response_format", "verbose_json");

    const request: RequestInit = { method: "POST", body };
    if (this.#token) request.headers = { authorization: `Bearer ${this.#token}` };

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, request);
    } catch {
      throw new ProviderError(this.name, "transcription_failed");
    }
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
