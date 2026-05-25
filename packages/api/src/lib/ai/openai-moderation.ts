// OpenAI moderation provider. Maps the `omni-moderation-latest` response into
// our normalized result shape.

import type { ModerationInput, ModerationProvider, ModerationResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAiModerationOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  readonly rejectThreshold: number;
  readonly approveThreshold: number;
}

interface OpenAiModerationCategoryMap {
  readonly [category: string]: boolean;
}

interface OpenAiModerationScoreMap {
  readonly [category: string]: number;
}

interface OpenAiModerationResult {
  readonly flagged: boolean;
  readonly categories: OpenAiModerationCategoryMap;
  readonly category_scores: OpenAiModerationScoreMap;
}

interface OpenAiModerationResponse {
  readonly results?: readonly OpenAiModerationResult[];
}

const isModerationResponse = (payload: unknown): payload is OpenAiModerationResponse =>
  typeof payload === "object" &&
  payload !== null &&
  Array.isArray((payload as { results?: unknown }).results);

export class OpenAiModerationProvider implements ModerationProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #rejectThreshold: number;
  readonly #approveThreshold: number;

  constructor(opts: OpenAiModerationOptions) {
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#rejectThreshold = opts.rejectThreshold;
    this.#approveThreshold = opts.approveThreshold;
  }

  async moderate(input: ModerationInput): Promise<ModerationResult> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/moderations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: input.text }),
    });
    if (!response.ok) {
      // Discard response body — never include upstream text in errors.
      await response.text().catch(() => "");
      throw new ProviderError(this.name, "moderation_failed", response.status);
    }
    const payload: unknown = await response.json().catch(() => ({}));
    if (
      !isModerationResponse(payload) ||
      payload.results === undefined ||
      payload.results.length === 0
    ) {
      throw new ProviderError(this.name, "no_results_in_response");
    }
    const first = payload.results[0];
    if (first === undefined) {
      throw new ProviderError(this.name, "no_results_in_response");
    }
    const scores = first.category_scores;
    let maxScore = 0;
    let topCategory: string | undefined;
    for (const [name, value] of Object.entries(scores)) {
      if (typeof value === "number" && value > maxScore) {
        maxScore = value;
        topCategory = name;
      }
    }
    const flaggedCategories = Object.entries(first.categories)
      .filter(([, flagged]) => flagged === true)
      .map(([name]) => name);
    const recommendation: "approve" | "review" | "reject" =
      first.flagged || maxScore >= this.#rejectThreshold
        ? "reject"
        : maxScore <= this.#approveThreshold
          ? "approve"
          : "review";
    const reasonSummary =
      flaggedCategories.length > 0
        ? flaggedCategories.join(", ")
        : topCategory && maxScore > 0
          ? `${topCategory} (${maxScore.toFixed(2)})`
          : undefined;
    return {
      flagged: first.flagged,
      recommendation,
      maxScore,
      categories: scores,
      ...(reasonSummary === undefined ? {} : { reasonSummary }),
    };
  }
}
