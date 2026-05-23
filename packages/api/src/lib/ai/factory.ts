// Factory: turns the env-driven `AiConfig` into concrete provider instances,
// or `null` when the provider is disabled / misconfigured.

import { resolveAiConfig, type AiConfig } from "./config.js";
import { MacAppModerationProvider } from "./mac-app-moderation.js";
import { MacAppTranscriptionProvider } from "./mac-app-transcription.js";
import { OpenAiModerationProvider } from "./openai-moderation.js";
import { OpenAiTranscriptionProvider } from "./openai-transcription.js";
import type { ModerationProvider, TranscriptionProvider } from "./types.js";

export const buildTranscriptionProvider = (config: AiConfig = resolveAiConfig()): TranscriptionProvider | null => {
  switch (config.transcriptionProvider) {
    case "disabled":
      return null;
    case "openai":
      if (!config.openAiApiKey) return null;
      return new OpenAiTranscriptionProvider({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.transcriptionOpenAiModel,
      });
    case "mac_app":
      if (!config.transcriptionMacAppUrl) return null;
      return new MacAppTranscriptionProvider({
        url: config.transcriptionMacAppUrl,
        token: config.transcriptionMacAppToken,
      });
  }
};

export const buildModerationProvider = (config: AiConfig = resolveAiConfig()): ModerationProvider | null => {
  switch (config.moderationProvider) {
    case "disabled":
      return null;
    case "openai":
      if (!config.openAiApiKey) return null;
      return new OpenAiModerationProvider({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.moderationOpenAiModel,
        rejectThreshold: config.autoRejectThreshold,
        approveThreshold: config.autoApproveThreshold,
      });
    case "mac_app":
      if (!config.moderationMacAppUrl) return null;
      return new MacAppModerationProvider({
        url: config.moderationMacAppUrl,
        token: config.moderationMacAppToken,
      });
  }
};
