// Mac-app moderation provider. POSTs OpenAI-shaped JSON to the Transcription
// macOS app's OpenAI-compatible moderation endpoint.

import type { ModerationInput, ModerationProvider, ModerationResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface MacAppModerationOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
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
  readonly reasonSummary?: unknown;
  readonly reason_summary?: unknown;
}

interface OpenAiModerationResponse {
  readonly results?: readonly OpenAiModerationResult[];
  readonly reasonSummary?: unknown;
  readonly reason_summary?: unknown;
}

const moderationPath = "/v1/moderations";

const endpointFromUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(moderationPath)) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/moderations`;
  return `${trimmed}${moderationPath}`;
};

const isModerationResponse = (payload: unknown): payload is OpenAiModerationResponse =>
  typeof payload === "object" &&
  payload !== null &&
  Array.isArray((payload as { results?: unknown }).results);

const readReasonSummary = (
  payload: OpenAiModerationResponse | OpenAiModerationResult,
): string | undefined => {
  if (typeof payload.reasonSummary === "string") return payload.reasonSummary;
  if (typeof payload.reason_summary === "string") return payload.reason_summary;
  return undefined;
};

export class MacAppModerationProvider implements ModerationProvider {
  readonly name = "mac_app" as const;
  readonly model: string;
  readonly #endpoint: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #upstreamModel: string | null;
  readonly #rejectThreshold: number;
  readonly #approveThreshold: number;

  constructor(opts: MacAppModerationOptions) {
    this.model = opts.model ?? "mac-app";
    this.#endpoint = endpointFromUrl(opts.url);
    this.#token = opts.token;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#upstreamModel = opts.model ?? null;
    this.#rejectThreshold = opts.rejectThreshold;
    this.#approveThreshold = opts.approveThreshold;
  }

  async moderate(input: ModerationInput): Promise<ModerationResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
        body: JSON.stringify({
          ...(this.#upstreamModel ? { model: this.#upstreamModel } : {}),
          input: input.text,
        }),
      });
    } catch {
      throw new ProviderError(this.name, "moderation_failed");
    }
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
    for (const value of Object.values(scores)) {
      if (typeof value === "number" && value > maxScore) {
        maxScore = value;
      }
    }
    const recommendation: "approve" | "review" | "reject" =
      first.flagged || maxScore >= this.#rejectThreshold
        ? "reject"
        : maxScore <= this.#approveThreshold
          ? "approve"
          : "review";
    const reasonSummary = readReasonSummary(first) ?? readReasonSummary(payload);
    return {
      flagged: first.flagged,
      recommendation,
      maxScore,
      categories: scores,
      ...(reasonSummary === undefined ? {} : { reasonSummary }),
    };
  }
}
