// Env-driven configuration for the AI pipeline. Reads are lazy because tests
// mutate `process.env` between cases and the production server reads once at
// startup; either way the resolver simply re-reads on demand.

import { z } from "zod";

export type TranscriptionProviderName = "openai" | "mac_app" | "disabled";
export type TranslationProviderName = "openai" | "mac_app" | "disabled";
export type ModerationProviderName = "openai" | "mac_app" | "disabled";
export type AutoDecisionMode = "always_pending" | "auto_reject" | "auto_both";

const TranscriptionProviderEnum = z.enum(["openai", "mac_app", "disabled"]);
const TranslationProviderEnum = z.enum(["openai", "mac_app", "disabled"]);
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

// 25 MiB — matches OpenAI Whisper's upload limit.
export const DEFAULT_MAX_AUDIO_BYTES = 26_214_400;

// English language tags that mean "no translation needed". Anything not in
// this set is treated as non-English and routed to the translation step.
export const ENGLISH_LANGUAGE_TAGS = new Set<string>([
  "en",
  "en-us",
  "en-gb",
  "en-au",
  "en-ca",
  "en-ie",
  "en-in",
  "en-nz",
  "en-za",
  "english",
]);

export const isEnglishLanguage = (language: string | null | undefined): boolean => {
  if (!language) return true;
  return ENGLISH_LANGUAGE_TAGS.has(language.trim().toLowerCase());
};

export interface AiConfig {
  readonly transcriptionProvider: TranscriptionProviderName;
  readonly transcriptionOpenAiModel: string;
  readonly transcriptionMacAppUrl: string | null;
  readonly transcriptionMacAppToken: string | null;
  readonly translationProvider: TranslationProviderName;
  readonly translationOpenAiModel: string;
  readonly translationMacAppUrl: string | null;
  readonly translationMacAppToken: string | null;
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
  readonly maxAudioBytes: number;
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
    translationProvider: TranslationProviderEnum.catch("disabled" as const).parse(
      env.TRANSLATION_PROVIDER ?? "disabled",
    ),
    translationOpenAiModel: trimmedOrNull(env.TRANSLATION_OPENAI_MODEL) ?? "gpt-4o-mini",
    translationMacAppUrl: trimmedOrNull(env.TRANSLATION_MAC_APP_URL),
    translationMacAppToken: trimmedOrNull(env.TRANSLATION_MAC_APP_TOKEN),
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
    maxAudioBytes: parseInteger(env.MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES, 1),
    sweeperStaleThresholdSeconds: parseInteger(env.AI_SWEEPER_STALE_THRESHOLD_SECONDS, 300, 10),
  };
};
