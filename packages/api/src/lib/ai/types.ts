// AI provider interfaces. Concrete implementations live alongside this file.
// Each transcription and moderation provider is independently selectable via
// env vars; see `config.ts` for the factory.

import type { AiProvider } from "@telephone-booth-operator/shared";

export interface TranscriptionInput {
  readonly audioUrl: string;
  readonly sha256: string;
  readonly durationMs: number | null;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language: string | null;
}

export interface TranscriptionProvider {
  readonly name: AiProvider;
  readonly model: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export interface ModerationInput {
  readonly text: string;
}

export interface ModerationResult {
  readonly flagged: boolean;
  readonly recommendation: "approve" | "review" | "reject";
  readonly maxScore: number;
  readonly categories: Record<string, number>;
  readonly reasonSummary?: string;
}

export interface ModerationProvider {
  readonly name: AiProvider;
  readonly model: string;
  moderate(input: ModerationInput): Promise<ModerationResult>;
}

// Thrown by providers for callers (routes / pipeline) to distinguish
// "provider returned an error" from accidental exceptions.
export class ProviderError extends Error {
  constructor(
    readonly provider: AiProvider,
    readonly errorCode: string,
    readonly status?: number,
  ) {
    super(`${provider}/${errorCode}${status ? `/${status}` : ""}`);
    this.name = "ProviderError";
  }
}

export class ProviderDisabledError extends Error {
  constructor(readonly kind: "transcription" | "moderation") {
    super(`${kind} provider disabled`);
    this.name = "ProviderDisabledError";
  }
}
