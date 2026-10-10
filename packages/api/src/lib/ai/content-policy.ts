import type { ModerationResult } from "./types.js";

const profanityPatterns = [
  /\bf[\W_]*u[\W_]*c[\W_]*k(?:ing|ed|er|s)?\b/i,
  /\bs[\W_]*h[\W_]*i[\W_]*t(?:ty|s)?\b/i,
  /\bb[\W_]*i[\W_]*t[\W_]*c[\W_]*h(?:es|y)?\b/i,
  /\bc[\W_]*u[\W_]*n[\W_]*t(?:s)?\b/i,
  /\bass[\W_]*hole(?:s)?\b/i,
  /\bdick(?:s|head)?\b/i,
  /\bprick(?:s)?\b/i,
  /\bwhore(?:s)?\b/i,
];

const slurPatterns = [
  /\bn[\W_]*[i1!][\W_]*[gq][\W_]*[gq][\W_]*(?:[ae3][\W_]*r?|[a@])s?\b/i,
  /\bf[\W_]*a[\W_]*g(?:g[\W_]*o[\W_]*t)?s?\b/i,
  /\bk[\W_]*i[\W_]*k[\W_]*e[\W_]*s?\b/i,
  /\bs[\W_]*p[\W_]*i[\W_]*c[\W_]*s?\b/i,
  /\bc[\W_]*h[\W_]*i[\W_]*n[\W_]*k[\W_]*s?\b/i,
  /\bg[\W_]*o[\W_]*o[\W_]*k[\W_]*s?\b/i,
  /\btrann(?:y|ies)\b/i,
  /\br[\W_]*e[\W_]*t[\W_]*a[\W_]*r[\W_]*d(?:ed|s)?\b/i,
];

const containsAny = (text: string, patterns: readonly RegExp[]) =>
  patterns.some((pattern) => pattern.test(text));

export const applyPublicPlaybackLanguagePolicy = (
  text: string,
  result: ModerationResult,
): ModerationResult => {
  if (containsAny(text, slurPatterns)) {
    return {
      ...result,
      flagged: true,
      recommendation: "reject",
      maxScore: Math.max(result.maxScore, 0.85),
      reasonSummary:
        "The message contains a slur or offensive language and should not be approved for public playback.",
    };
  }

  if (result.recommendation === "approve" && containsAny(text, profanityPatterns)) {
    return {
      ...result,
      recommendation: "review",
      maxScore: Math.max(result.maxScore, 0.51),
      reasonSummary:
        "The message contains profanity or offensive language and needs human review before public playback.",
    };
  }

  return result;
};
