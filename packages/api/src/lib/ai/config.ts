// Env-driven configuration for the AI pipeline. Reads are lazy because tests
// mutate `process.env` between cases and the production server reads once at
// startup; either way the resolver simply re-reads on demand.

import { z } from "zod";

export type TranscriptionProviderName = "openai" | "mac_app" | "disabled";
export type ModerationProviderName = "openai" | "mac_app" | "disabled";
export type AutoDecisionMode = "always_pending" | "auto_reject" | "auto_both";

const TranscriptionProviderEnum = z.enum(["openai", "mac_app", "disabled"]);
const ModerationProviderEnum = z.enum(["openai", "mac_app", "disabled"]);
const AutoDecisionModeEnum = z.enum(["always_pending", "auto_reject", "auto_both"]);

const parseFloat01 = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
};

const parseInteger = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
};

export interface AiConfig {
  readonly transcriptionProvider: TranscriptionProviderName;
  readonly transcriptionOpenAiModel: string;
  readonly transcriptionMacAppUrl: string | null;
  readonly transcriptionMacAppToken: string | null;
  readonly moderationProvider: ModerationProviderName;
  readonly moderationOpenAiModel: string;
  readonly moderationMacAppUrl: string | null;
  readonly moderationMacAppToken: string | null;
  readonly openAiApiKey: string | null;
  readonly openAiBaseUrl: string;
  readonly autoDecisionMode: AutoDecisionMode;
  readonly autoRejectThreshold: number;
  readonly autoApproveThreshold: number;
  readonly sweeperIntervalSeconds: number;
  readonly sweeperStaleThresholdSeconds: number;
}

const trimmedOrNull = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  return value && value.length > 0 ? value : null;
};

export const resolveAiConfig = (): AiConfig => {
  const env = process.env;
  return {
    transcriptionProvider: TranscriptionProviderEnum.catch("disabled" as const).parse(
      env.TRANSCRIPTION_PROVIDER ?? "disabled",
    ),
    transcriptionOpenAiModel: trimmedOrNull(env.TRANSCRIPTION_OPENAI_MODEL) ?? "whisper-1",
    transcriptionMacAppUrl: trimmedOrNull(env.TRANSCRIPTION_MAC_APP_URL),
    transcriptionMacAppToken: trimmedOrNull(env.TRANSCRIPTION_MAC_APP_TOKEN),
    moderationProvider: ModerationProviderEnum.catch("disabled" as const).parse(
      env.MODERATION_PROVIDER ?? "disabled",
    ),
    moderationOpenAiModel: trimmedOrNull(env.MODERATION_OPENAI_MODEL) ?? "omni-moderation-latest",
    moderationMacAppUrl: trimmedOrNull(env.MODERATION_MAC_APP_URL),
    moderationMacAppToken: trimmedOrNull(env.MODERATION_MAC_APP_TOKEN),
    openAiApiKey: trimmedOrNull(env.OPENAI_API_KEY),
    openAiBaseUrl: trimmedOrNull(env.OPENAI_BASE_URL) ?? "https://api.openai.com",
    autoDecisionMode: AutoDecisionModeEnum.catch("always_pending" as const).parse(
      env.AUTO_DECISION_MODE ?? "always_pending",
    ),
    autoRejectThreshold: parseFloat01(env.AUTO_REJECT_THRESHOLD, 0.85),
    autoApproveThreshold: parseFloat01(env.AUTO_APPROVE_THRESHOLD, 0.15),
    sweeperIntervalSeconds: parseInteger(env.AI_SWEEPER_INTERVAL_SECONDS, 60),
    sweeperStaleThresholdSeconds: parseInteger(env.AI_SWEEPER_STALE_THRESHOLD_SECONDS, 300, 10),
  };
};
