// OpenAI translation provider. Sends a transcript through the configured
// chat-completion endpoint with a fixed system prompt that asks for an
// English translation. Bypassed entirely when the input language is already
// English (caller's responsibility — see `pipeline.ts`).

import type { TranslationInput, TranslationProvider, TranslationResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAiTranslationOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  "You are a translation engine. Translate the user's message into English. " +
  "Respond ONLY with the translated text. Do not add quotes, explanations, " +
  "preambles, or commentary. If the input is already English, repeat it verbatim.";

export class OpenAiTranslationProvider implements TranslationProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAiTranslationOptions) {
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const payload = {
      model: this.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.text },
      ],
    };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new ProviderError(this.name, "translation_failed");
    }
    if (!response.ok) {
      await response.text().catch(() => "");
      throw new ProviderError(this.name, "translation_failed", response.status);
    }
    const body = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (text.length === 0) {
      throw new ProviderError(this.name, "translation_empty");
    }
    return { text, language: "en" };
  }
}
