// Mac-app translation provider. Hits the Transcription macOS app's custom
// `/v1/translations` endpoint, which proxies to the configured translation
// upstream (chat-completion-style) and returns English text.

import type { TranslationInput, TranslationProvider, TranslationResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface MacAppTranslationOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
}

const translationPath = "/v1/translations";

const endpointFromUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(translationPath)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/translations`;
  return `${trimmed}${translationPath}`;
};

export class MacAppTranslationProvider implements TranslationProvider {
  readonly name = "mac_app" as const;
  readonly model: string;
  readonly #endpoint: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;

  constructor(opts: MacAppTranslationOptions) {
    this.model = opts.model ?? "mac-app";
    this.#endpoint = endpointFromUrl(opts.url);
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const body = JSON.stringify({
      input: input.text,
      source_language: input.sourceLanguage,
      target_language: "en",
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, { method: "POST", headers, body });
    } catch {
      throw new ProviderError(this.name, "translation_failed");
    }
    if (!response.ok) {
      await response.text().catch(() => "");
      throw new ProviderError(this.name, "translation_failed", response.status);
    }
    const payload = (await response.json().catch(() => ({}))) as {
      text?: unknown;
      language?: unknown;
    };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text.length === 0) {
      throw new ProviderError(this.name, "translation_empty");
    }
    const language = typeof payload.language === "string" ? payload.language : "en";
    return { text, language };
  }
}
