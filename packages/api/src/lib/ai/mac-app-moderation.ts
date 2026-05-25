// Mac-app moderation stub. POSTs `{ text }` to the configured URL and expects
// `{ flagged, recommendation, maxScore, categories, reasonSummary? }`.
// Contract documented in `docs/transcription-providers.md`.

import type { ModerationInput, ModerationProvider, ModerationResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface MacAppModerationOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
}

interface MacAppModerationPayload {
  readonly flagged?: unknown;
  readonly recommendation?: unknown;
  readonly maxScore?: unknown;
  readonly categories?: unknown;
  readonly reasonSummary?: unknown;
}

const toCategoryMap = (raw: unknown): Record<string, number> => {
  if (typeof raw !== "object" || raw === null) return {};
  const map: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") map[key] = value;
  }
  return map;
};

export class MacAppModerationProvider implements ModerationProvider {
  readonly name = "mac_app" as const;
  readonly model: string;
  readonly #url: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;

  constructor(opts: MacAppModerationOptions) {
    this.model = opts.model ?? "mac-app";
    this.#url = opts.url;
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async moderate(input: ModerationInput): Promise<ModerationResult> {
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      body: JSON.stringify({ text: input.text }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        this.name,
        `mac-app moderation failed: ${response.status} ${text.slice(0, 200)}`,
        response.status,
      );
    }
    const raw = (await response.json().catch(() => ({}))) as MacAppModerationPayload;
    const recommendation =
      raw.recommendation === "approve" ||
      raw.recommendation === "reject" ||
      raw.recommendation === "review"
        ? raw.recommendation
        : "review";
    const flagged = typeof raw.flagged === "boolean" ? raw.flagged : recommendation === "reject";
    const maxScore =
      typeof raw.maxScore === "number" && raw.maxScore >= 0 && raw.maxScore <= 1 ? raw.maxScore : 0;
    return {
      flagged,
      recommendation,
      maxScore,
      categories: toCategoryMap(raw.categories),
      ...(typeof raw.reasonSummary === "string" ? { reasonSummary: raw.reasonSummary } : {}),
    };
  }
}
