// Shared Zod schemas + TypeScript types for the operator API contract.
// Both `packages/api` and `packages/web` import from here so the wire
// types are guaranteed to agree.

import { z } from "zod";

export const BoothStateSchema = z.enum([
  "idle",
  "dialTone",
  "dialing",
  "playingQuestion",
  "beep",
  "recording",
  "uploading",
  "playingMessage",
  "playingInstructions",
  "callUnavailable",
  "error",
]);
export type BoothState = z.infer<typeof BoothStateSchema>;

export const MessageStatusSchema = z.enum([
  "uploading",
  "received",
  "pending",
  "approved",
  "rejected",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AudioRefSchema = z.object({
  url: z.string().url(),
  sha256: Sha256Schema,
  durationMs: z.number().int().positive().nullable(),
});
export type AudioRef = z.infer<typeof AudioRefSchema>;

// -----------------------------------------------------------------------------
// AI: transcription + moderation. See docs/transcription-providers.md.
// -----------------------------------------------------------------------------
export const TranscriptionStatusSchema = z.enum(["pending", "succeeded", "failed"]);
export type TranscriptionStatus = z.infer<typeof TranscriptionStatusSchema>;

export const ModerationRecommendationSchema = z.enum(["approve", "review", "reject"]);
export type ModerationRecommendation = z.infer<typeof ModerationRecommendationSchema>;

// A local, no-speech review is separate from content moderation. It remains
// advisory: "delete" tells a human reviewer what the device recommends, not
// something the server will ever do by itself.
export const MessageReviewClassificationSchema = z.enum(["likely_hangup", "unclear"]);
export type MessageReviewClassification = z.infer<typeof MessageReviewClassificationSchema>;

export const MessageReviewRecommendationSchema = z.enum(["delete", "review"]);
export type MessageReviewRecommendation = z.infer<typeof MessageReviewRecommendationSchema>;

// Provider label recorded on a transcription / moderation row. `openai`,
// `mac_app`, `push` and `disabled` are the configurable server-side providers;
// `on_device` is not configurable — it marks a result an operator's own device
// computed locally and submitted, so the UI can label it as such.
export const AiProviderSchema = z.enum(["openai", "mac_app", "push", "on_device", "disabled"]);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const TranscriptionSchema = z.object({
  id: z.guid(),
  messageId: z.guid(),
  provider: AiProviderSchema,
  model: z.string().nullable(),
  status: TranscriptionStatusSchema,
  text: z.string().nullable(),
  language: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  requestedById: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  translationStatus: TranscriptionStatusSchema.nullable(),
  translatedText: z.string().nullable(),
  translatedLanguage: z.string().nullable(),
  translationProvider: AiProviderSchema.nullable(),
  translationModel: z.string().nullable(),
  translationError: z.string().nullable(),
  translationLatencyMs: z.number().int().nonnegative().nullable(),
  translationCompletedAt: z.string().datetime().nullable(),
});
export type Transcription = z.infer<typeof TranscriptionSchema>;

export const TranscriptionListSchema = z.object({ items: z.array(TranscriptionSchema) });
export type TranscriptionList = z.infer<typeof TranscriptionListSchema>;

export const ModerationSchema = z.object({
  id: z.guid(),
  messageId: z.guid(),
  transcriptionId: z.guid().nullable(),
  provider: AiProviderSchema,
  model: z.string().nullable(),
  status: TranscriptionStatusSchema,
  flagged: z.boolean().nullable(),
  recommendation: ModerationRecommendationSchema.nullable(),
  maxScore: z.number().min(0).max(1).nullable(),
  categories: z.record(z.string(), z.number()).nullable(),
  reasonSummary: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  requestedById: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type Moderation = z.infer<typeof ModerationSchema>;

// How the booth is being driven. `real` is a normal production booth with
// `booth-pi` HAL adapters; `mock` is the in-memory `booth-mock` adapters
// (no rotary phone wired in); `simulator` is the interactive `ratatui` TUI
// (which can itself sit on top of either mock or real adapters — TUI input
// is the user-visible fact, so simulator wins over mock when both are set).
// Optional on the wire so older booths predating this field still validate.
export const RuntimeModeSchema = z.enum(["real", "mock", "simulator"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const BoothStatusSchema = z.object({
  state: BoothStateSchema,
  updatedAt: z.string().datetime(),
  // True only for the API's id-less placeholder when the selected
  // installation has no persisted booth status yet. Optional so clients can
  // still read responses from older API builds.
  isSynthetic: z.boolean().optional(),
  currentQuestionId: z.guid().nullable().optional(),
  currentMessageId: z.guid().nullable().optional(),
  lastError: z.string().nullable().optional(),
  runtimeMode: RuntimeModeSchema.nullable().optional(),
  // The booth re-reports its current status on a heartbeat, so an unchanged
  // booth produces many identical reports. The operator collapses those into a
  // single snapshot: `firstSeenAt` is when the booth entered this status,
  // `updatedAt` is the newest report of it, and `repeatCount` is how many
  // reports were folded in (1 for a status reported exactly once). Both are
  // optional so older API builds still validate.
  firstSeenAt: z.string().datetime().optional(),
  repeatCount: z.number().int().min(1).optional(),
  // The snapshot's row id. Two runs of the same status can share a booth
  // timestamp, so clients need it to tell one row from another; it increases
  // with insertion order, which is also the operator's tie-break for equal
  // timestamps.
  id: z.number().int().optional(),
});
export type BoothStatus = z.infer<typeof BoothStatusSchema>;

export const StatsSummarySchema = z.object({
  booth: BoothStatusSchema,
  messages: z.object({
    pending: z.number().int().nonnegative(),
    awaitingModeration: z.number().int().nonnegative(),
    receivedToday: z.number().int().nonnegative(),
    latestId: z.guid().nullable(),
  }),
  calls: z.object({
    today: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
  }),
  realtime: z.object({
    wsClients: z.number().int().nonnegative(),
  }),
  dayStartedAt: z.string().datetime(),
  generatedAt: z.string().datetime(),
  timeZone: z.string().min(1).max(64),
});
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

export const MonitorSummarySchema = z.object({
  callsToday: z.number().int().nonnegative(),
  messagesToday: z.number().int().nonnegative(),
  callsTotal: z.number().int().nonnegative(),
  messagesTotal: z.number().int().nonnegative(),
  dayStartedAt: z.string().datetime(),
  generatedAt: z.string().datetime(),
  timeZone: z.string().min(1).max(64),
});
export type MonitorSummary = z.infer<typeof MonitorSummarySchema>;

// Booth-supplied half of the wire shape: collapsing metadata is derived by the
// operator, never sent by the booth.
export const StatusUpdateSchema = BoothStatusSchema.omit({
  updatedAt: true,
  isSynthetic: true,
  firstSeenAt: true,
  repeatCount: true,
  id: true,
}).extend({
  updatedAt: z.string().datetime().optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

export const QuestionStatusSchema = z.enum(["draft", "active", "archived"]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export const InstructionStatusSchema = z.enum(["active", "inactive"]);
export type InstructionStatus = z.infer<typeof InstructionStatusSchema>;

export const QuestionSchema = z.object({
  id: z.guid(),
  prompt: z.string().min(1).max(280),
  status: QuestionStatusSchema,
  createdAt: z.string().datetime(),
  audio: AudioRefSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionCreateSchema = z.object({
  prompt: z.string().min(1).max(280),
  audioFileId: z.guid(),
  status: QuestionStatusSchema.optional(),
});
export type QuestionCreate = z.infer<typeof QuestionCreateSchema>;

export const QuestionUpdateSchema = z.object({
  prompt: z.string().min(1).max(280),
});
export type QuestionUpdate = z.infer<typeof QuestionUpdateSchema>;

export const InstructionSchema = z.object({
  id: z.guid(),
  description: z.string().max(280).nullable(),
  status: InstructionStatusSchema,
  createdAt: z.string().datetime(),
  audio: AudioRefSchema,
});
export type Instruction = z.infer<typeof InstructionSchema>;

export const InstructionCreateSchema = z.object({
  description: z.string().max(280).optional(),
  audioFileId: z.guid(),
  status: InstructionStatusSchema.optional(),
});
export type InstructionCreate = z.infer<typeof InstructionCreateSchema>;

export const InstructionUpdateSchema = z.object({
  description: z.string().max(280).nullable(),
});
export type InstructionUpdate = z.infer<typeof InstructionUpdateSchema>;

export const MessageSchema = z.object({
  id: z.guid(),
  status: MessageStatusSchema,
  // Which era the recording belongs to. Present so a cross-era view can tell
  // which rows are still editable without asking the API row by row.
  installationId: z.guid().nullable().optional(),
  questionId: z.guid().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  receivedAt: z.string().datetime().nullable().optional(),
  decidedAt: z.string().datetime().nullable().optional(),
  decidedById: z.string().nullable().optional(),
  reviewClassification: MessageReviewClassificationSchema.nullable().optional(),
  reviewRecommendation: MessageReviewRecommendationSchema.nullable().optional(),
  reviewClassifiedAt: z.string().datetime().nullable().optional(),
  reviewClassifiedById: z.string().nullable().optional(),
  audio: AudioRefSchema,
  latestTranscription: TranscriptionSchema.nullable().optional(),
  latestModeration: ModerationSchema.nullable().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

const GRANDFATHERED_LANGUAGE_TAGS = new Map<string, string>([
  ["art-lojban", "jbo"],
  ["cel-gaulish", "xtg-x-cel-gaulish"],
  ["en-gb-oed", "en-GB-oxendict"],
  ["i-ami", "ami"],
  ["i-bnn", "bnn"],
  ["i-default", "i-default"],
  ["i-enochian", "i-enochian"],
  ["i-hak", "hak"],
  ["i-klingon", "tlh"],
  ["i-lux", "lb"],
  ["i-mingo", "i-mingo"],
  ["i-navajo", "nv"],
  ["i-pwn", "pwn"],
  ["i-tao", "tao"],
  ["i-tay", "tay"],
  ["i-tsu", "tsu"],
  ["no-bok", "nb"],
  ["no-nyn", "nn"],
  ["sgn-be-fr", "sfb"],
  ["sgn-be-nl", "vgt"],
  ["sgn-ch-de", "sgg"],
  ["zh-guoyu", "cmn"],
  ["zh-hakka", "hak"],
  ["zh-min", "zh-min"],
  ["zh-min-nan", "nan"],
  ["zh-xiang", "hsn"],
]);

const alpha = /^[A-Za-z]+$/;
const alphanumeric = /^[A-Za-z0-9]+$/;

const isVariant = (subtag: string): boolean =>
  /^[A-Za-z0-9]{5,8}$/.test(subtag) || /^[0-9][A-Za-z0-9]{3}$/.test(subtag);

// RFC 5646, section 2.1.  `Intl.getCanonicalLocales` supplies registry-aware
// canonicalization; the parser covers valid private-use and grandfathered tags
// that ECMA-402 locale identifiers intentionally exclude.
const canonicalizeBcp47LanguageTag = (value: string): string | null => {
  const tag = value.trim();
  if (tag.length === 0 || tag.length > 64 || !/^[A-Za-z0-9-]+$/.test(tag)) return null;

  const grandfathered = GRANDFATHERED_LANGUAGE_TAGS.get(tag.toLowerCase());
  if (grandfathered !== undefined) return grandfathered;

  const subtags = tag.split("-");
  if (
    subtags.some((subtag) => subtag.length === 0 || subtag.length > 8 || !alphanumeric.test(subtag))
  ) {
    return null;
  }

  if (subtags[0]?.toLowerCase() === "x") {
    return subtags.length > 1
      ? `x-${subtags
          .slice(1)
          .map((subtag) => subtag.toLowerCase())
          .join("-")}`
      : null;
  }

  const language = subtags[0];
  if (
    language === undefined ||
    !(
      (/^[A-Za-z]{2,3}$/.test(language) && language.length <= 3) ||
      /^[A-Za-z]{4}$/.test(language) ||
      /^[A-Za-z]{5,8}$/.test(language)
    )
  ) {
    return null;
  }

  let index = 1;
  const canonicalSubtags = [language.toLowerCase()];
  if (language.length <= 3) {
    let extlangs = 0;
    while (extlangs < 3 && alpha.test(subtags[index] ?? "") && subtags[index]?.length === 3) {
      canonicalSubtags.push(subtags[index]!.toLowerCase());
      index += 1;
      extlangs += 1;
    }
  }
  if (alpha.test(subtags[index] ?? "") && subtags[index]?.length === 4) {
    const script = subtags[index]!;
    canonicalSubtags.push(`${script[0]?.toUpperCase() ?? ""}${script.slice(1).toLowerCase()}`);
    index += 1;
  }
  if (
    (alpha.test(subtags[index] ?? "") && subtags[index]?.length === 2) ||
    /^[0-9]{3}$/.test(subtags[index] ?? "")
  ) {
    const region = subtags[index]!;
    canonicalSubtags.push(alpha.test(region) ? region.toUpperCase() : region);
    index += 1;
  }
  const variants = new Set<string>();
  while (isVariant(subtags[index] ?? "")) {
    const variant = subtags[index]!.toLowerCase();
    if (variants.has(variant)) return null;
    variants.add(variant);
    canonicalSubtags.push(variant);
    index += 1;
  }
  const singletons = new Set<string>();
  while (/^[0-9A-WY-Za-wy-z]$/.test(subtags[index] ?? "")) {
    const singleton = subtags[index]!.toLowerCase();
    if (singletons.has(singleton)) return null;
    singletons.add(singleton);
    canonicalSubtags.push(singleton);
    index += 1;
    const extensionStart = index;
    while (/^[A-Za-z0-9]{2,8}$/.test(subtags[index] ?? "")) {
      canonicalSubtags.push(subtags[index]!.toLowerCase());
      index += 1;
    }
    if (index === extensionStart) return null;
  }
  if (subtags[index]?.toLowerCase() === "x") {
    canonicalSubtags.push("x");
    index += 1;
    const privateUseStart = index;
    while (/^[A-Za-z0-9]{1,8}$/.test(subtags[index] ?? "")) {
      canonicalSubtags.push(subtags[index]!.toLowerCase());
      index += 1;
    }
    if (index === privateUseStart) return null;
  }
  if (index !== subtags.length) return null;

  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    // A grammar-valid tag can still be outside ECMA-402's locale subset. Keep
    // its RFC 5646 casing canonical rather than rejecting valid BCP-47 input.
    return canonicalSubtags.join("-");
  }
};

export const Bcp47LanguageTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    if (canonicalizeBcp47LanguageTag(value) === null) {
      ctx.addIssue({ code: "custom", message: "Expected a BCP-47 language tag." });
    }
  })
  .transform((value) => canonicalizeBcp47LanguageTag(value) ?? value);

export const DefaultTranscriptionLanguageSchema = Bcp47LanguageTagSchema;
export type DefaultTranscriptionLanguage = z.infer<typeof DefaultTranscriptionLanguageSchema>;

// Human review actions. A logged-in operator can override the AI pipeline by
// approving or rejecting a message, and can supply a translation for a
// transcription the translation worker could not produce.
export const MessageDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  notes: z.string().max(2000).optional(),
});
export type MessageDecision = z.infer<typeof MessageDecisionSchema>;

export const TranslationSubmitSchema = z
  .object({
    transcriptionId: z.guid().optional(),
    expectedTranscriptionId: z.guid().optional(),
    expectedTranslationSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    translatedText: z.string().trim().min(1).max(20_000),
    translatedLanguage: z.string().trim().min(1).max(64).optional(),
    model: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .refine(
    ({ transcriptionId, expectedTranscriptionId }) =>
      !transcriptionId || !expectedTranscriptionId || transcriptionId === expectedTranscriptionId,
    { message: "transcription targets must match" },
  );
export type TranslationSubmit = z.infer<typeof TranslationSubmitSchema>;

// Operator-supplied transcript text (e.g. from the iOS Transcriber app doing
// on-device transcription). Text may be empty for a silent recording, mirroring
// the worker push-back callback. `language` and `model` are optional metadata.
export const TranscriptionSubmitSchema = z.object({
  expectedLatestTranscriptionId: z.guid().nullable().optional(),
  expectedLatestTranscriptionSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullable()
    .optional(),
  text: z.string().max(20_000),
  language: z.string().trim().min(1).max(64).nullable().optional(),
  model: z.string().trim().min(1).max(128).nullable().optional(),
  processDownstream: z.boolean().optional(),
});
export type TranscriptionSubmit = z.infer<typeof TranscriptionSubmitSchema>;

// Operator-supplied moderation verdict computed on the operator's own device
// (e.g. the iOS review app running Apple Intelligence). Mirrors the worker
// push-back callback payload; the verdict is advisory and never decides the
// message. `provider` is deliberately absent — the server stamps `on_device`
// so the UI can tell a locally computed verdict from an upstream one, and
// `model` carries the specific model that produced it.
export const ModerationSubmitSchema = z
  .object({
    transcriptionId: z.guid().nullable().optional(),
    inputSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    flagged: z.boolean(),
    recommendation: ModerationRecommendationSchema,
    maxScore: z.number().min(0).max(1),
    categories: z.record(z.string(), z.number()).optional(),
    reasonSummary: z.string().max(2000).nullable().optional(),
    model: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .refine((value) => (value.inputSha256 == null) === (value.transcriptionId == null), {
    message: "transcriptionId and inputSha256 must be supplied together",
    path: ["inputSha256"],
  });
export type ModerationSubmit = z.infer<typeof ModerationSubmitSchema>;

// 5 minutes — generous upper bound for booth recordings.
export const MAX_AUDIO_DURATION_MS = 300_000;

export const MessageCreateSchema = z.object({
  questionId: z.guid().optional(),
  durationMs: z.number().int().positive().max(MAX_AUDIO_DURATION_MS),
  sha256: Sha256Schema,
});
export type MessageCreate = z.infer<typeof MessageCreateSchema>;

export const MessageInitiatedSchema = z.object({
  id: z.guid(),
  uploadUrl: z.string().url(),
  blobName: z.string().min(1),
});
export type MessageInitiated = z.infer<typeof MessageInitiatedSchema>;

export const MessageCompleteSchema = z.object({
  id: z.guid(),
  // A completed upload goes straight to "pending" (the operator review queue).
  // "received" is only ever returned for the idempotent replay of a message
  // recorded before transcription became optional enrichment.
  status: MessageStatusSchema,
  receivedAt: z.string().datetime(),
});
export type MessageComplete = z.infer<typeof MessageCompleteSchema>;

export const AudioUploadContentTypeSchema = z.enum([
  "audio/flac",
  "audio/wav",
  "audio/x-wav",
  "audio/aiff",
  "audio/x-aiff",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
]);
export type AudioUploadContentType = z.infer<typeof AudioUploadContentTypeSchema>;

export const UploadSasRequestSchema = z.object({
  kind: z.enum(["message", "question-audio", "instruction-audio"]),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive(),
  contentType: AudioUploadContentTypeSchema,
});
export type UploadSasRequest = z.infer<typeof UploadSasRequestSchema>;

export const UploadSlotSchema = z.object({
  uploadUrl: z.string().url(),
  blobName: z.string().min(1),
  expiresAt: z.string().datetime(),
  audioFileId: z.guid().optional(),
});
export type UploadSlot = z.infer<typeof UploadSlotSchema>;

export const OperatorMeSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  groups: z.array(z.string()),
  isAdmin: z.boolean(),
  picture: z.string().url().optional(),
  providerName: z.string(),
});
export type OperatorMe = z.infer<typeof OperatorMeSchema>;

export const ApiTokenScopeSchema = z.enum(["operator", "worker", "monitor", "telemetry"]);
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>;

export const TelemetrySourceMetadataSchema = z
  .object({
    boothId: z.string().trim().min(1).max(128),
    componentId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128),
    kind: z.string().trim().min(1).max(64),
    prometheusJob: z.string().trim().min(1).max(256),
    prometheusInstance: z.string().trim().min(1).max(256),
  })
  .strict();
export type TelemetrySourceMetadata = z.infer<typeof TelemetrySourceMetadataSchema>;

export const CreateApiTokenRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    scope: ApiTokenScopeSchema.default("operator"),
    expiresInDays: z.number().int().positive().max(3650).optional(),
    telemetrySource: TelemetrySourceMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "telemetry" && !value.telemetrySource) {
      context.addIssue({
        code: "custom",
        path: ["telemetrySource"],
        message: "A telemetry token requires telemetrySource metadata.",
      });
    }
    if (value.scope !== "telemetry" && value.telemetrySource) {
      context.addIssue({
        code: "custom",
        path: ["telemetrySource"],
        message: "telemetrySource metadata is only valid for telemetry tokens.",
      });
    }
  });
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;

export const ApiTokenSchema = z.object({
  id: z.guid(),
  name: z.string(),
  scope: ApiTokenScopeSchema,
  last4: z.string().length(4),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  telemetrySource: TelemetrySourceMetadataSchema.optional(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const ApiTokenCreatedSchema = ApiTokenSchema.omit({
  lastUsedAt: true,
  revokedAt: true,
}).extend({
  plaintext: z.string(),
});
export type ApiTokenCreated = z.infer<typeof ApiTokenCreatedSchema>;

export const ApiTokenUsageBucketSchema = z.object({
  date: z.string(),
  count: z.number().int().nonnegative(),
});
export type ApiTokenUsageBucket = z.infer<typeof ApiTokenUsageBucketSchema>;

// -----------------------------------------------------------------------------
// Observability: booth event log, call sessions, and live system snapshots.
// -----------------------------------------------------------------------------
//
// Event type discriminator. Must stay in sync with the Rust booth's
// `TelemetryEvent` variants (see docs/observability.md "Telemetry events"
// section in the Telephone-Booth repo). The strings are serialized as the
// `type` field in `POST /v1/events` payloads.
export const BoothEventTypeSchema = z.enum([
  "call_started",
  "call_ended",
  "digit_dialed",
  "state_transition",
  "recording_started",
  "recording_stopped",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "gpio_edge",
  "audio_device_change",
  "operator_request",
  "operator_response",
  "error",
  "log",
  "system_sample",
]);
export type BoothEventType = z.infer<typeof BoothEventTypeSchema>;

// Mirrors the Rust `CallOutcome` enum: what the API will accept from the booth.
// `installation_ended` is deliberately absent — a client that could stamp it
// would mark its own session as closed by a rollover, and every later update to
// that session would then be refused as a straggler.
export const BoothReportedCallOutcomeSchema = z.enum([
  "hung_up_before_dial",
  "hung_up_during_prompt",
  "hung_up_during_recording",
  "hung_up_during_upload",
  "recording_completed",
  "recording_failed",
  "upload_failed",
  "operator_error",
  "aborted",
]);
export type BoothReportedCallOutcome = z.infer<typeof BoothReportedCallOutcomeSchema>;

// What can appear on a session in an API response: everything the booth
// reports, plus the outcome the rollover writes on calls the booth never
// closed itself.
export const CallOutcomeSchema = z.enum([
  ...BoothReportedCallOutcomeSchema.options,
  "installation_ended",
]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

// Maximum length for the running booth client (`telephone-booth`) version
// string. Matches the SemVer + pre-release/build-metadata grammar limit we
// expect in practice; mirrored on the API DB column.
export const BOOTH_CLIENT_VERSION_MAX = 64;

export const BoothEventSchema = z.object({
  eventId: z.string().min(1).max(128),
  boothId: z.string().min(1).max(64),
  bootId: z.guid(),
  type: BoothEventTypeSchema,
  occurredAt: z.string().datetime(),
  sessionId: z.guid().nullable().optional(),
  recordingId: z.string().min(1).max(128).nullable().optional(),
  payload: z.unknown().optional(),
  // Running version of the `telephone-booth` Rust client that produced the
  // event (e.g. `0.3.2`). Optional + nullable so older booths that don't
  // emit it still ingest cleanly.
  version: z.string().min(1).max(BOOTH_CLIENT_VERSION_MAX).nullable().optional(),
});
export type BoothEvent = z.infer<typeof BoothEventSchema>;

// Maximum batch size enforced server-side. Booth-side `event_forwarder`
// chunks into batches of at most `batch_max` (default 200) which is well
// under this cap.
export const BOOTH_EVENT_BATCH_MAX = 500;

export const BoothEventBatchSchema = z.object({
  events: z.array(BoothEventSchema).min(1).max(BOOTH_EVENT_BATCH_MAX),
});
export type BoothEventBatch = z.infer<typeof BoothEventBatchSchema>;

export const BoothEventBatchResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export type BoothEventBatchResponse = z.infer<typeof BoothEventBatchResponseSchema>;

// Server-shaped event row. `id` and `receivedAt` are operator-stamped;
// `payload` is the full JSON column.
export const BoothEventRecordSchema = BoothEventSchema.extend({
  id: z.string(),
  receivedAt: z.string().datetime(),
  payload: z.unknown(),
});
export type BoothEventRecord = z.infer<typeof BoothEventRecordSchema>;

export const BoothEventListSchema = z.object({
  items: z.array(BoothEventRecordSchema),
  nextCursor: z.string().nullable(),
});
export type BoothEventList = z.infer<typeof BoothEventListSchema>;

export const CallSessionSchema = z.object({
  id: z.guid(),
  boothId: z.string(),
  bootId: z.guid(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  digitsDialed: z.string().nullable(),
  outcome: CallOutcomeSchema.nullable(),
  recordingId: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  // Snapshot of the booth client version captured from the `call_started`
  // event (when present). Helps operators correlate calls with deployed
  // booth builds without scanning every event.
  version: z.string().min(1).max(BOOTH_CLIENT_VERSION_MAX).nullable(),
});
export type CallSession = z.infer<typeof CallSessionSchema>;

export const CallSessionListSchema = z.object({
  items: z.array(CallSessionSchema),
  nextCursor: z.string().nullable(),
});
export type CallSessionList = z.infer<typeof CallSessionListSchema>;

export const CallSessionDetailSchema = CallSessionSchema.extend({
  events: z.array(BoothEventRecordSchema),
});
export type CallSessionDetail = z.infer<typeof CallSessionDetailSchema>;

const nullableFiniteNumber = (minimum: number, maximum: number) =>
  z.number().finite().min(minimum).max(maximum).nullable().optional();
const nullableBoundedString = (maximum: number) => z.string().max(maximum).nullable().optional();

export const RouterBatterySnapshotSchema = z
  .object({
    present: z.boolean().nullable().optional(),
    chargePercent: nullableFiniteNumber(0, 100),
    temperatureCelsius: nullableFiniteNumber(-100, 250),
    voltageVolts: nullableFiniteNumber(0, 1000),
    currentAmperes: nullableFiniteNumber(-1000, 1000),
    health: nullableBoundedString(128),
    technology: nullableBoundedString(128),
    cycleCount: z.number().int().min(0).max(10_000_000).nullable().optional(),
    // GL.iNet MCU `charge_cnt`; distinct from the kernel battery cycle count.
    chargeCount: z.number().int().min(0).max(10_000_000).nullable().optional(),
    abnormal: z.boolean().nullable().optional(),
    abnormalType: z.number().int().min(-1).max(255).nullable().optional(),
  })
  .passthrough();
export type RouterBatterySnapshot = z.infer<typeof RouterBatterySnapshotSchema>;

export const RouterChargerSnapshotSchema = z
  .object({
    present: z.boolean().nullable().optional(),
    online: z.boolean().nullable().optional(),
    status: nullableBoundedString(128),
    usbType: nullableBoundedString(128),
    manufacturer: nullableBoundedString(256),
    model: nullableBoundedString(256),
    chargeType: nullableBoundedString(128),
    inputVoltageLimitVolts: nullableFiniteNumber(0, 1000),
    inputCurrentLimitAmperes: nullableFiniteNumber(0, 1000),
    constantChargeVoltageVolts: nullableFiniteNumber(0, 1000),
    constantChargeCurrentMaxAmperes: nullableFiniteNumber(0, 1000),
    fastCharge: z.boolean().nullable().optional(),
    chargingStatus: z.number().int().min(-1).max(255).nullable().optional(),
  })
  .passthrough();
export type RouterChargerSnapshot = z.infer<typeof RouterChargerSnapshotSchema>;

export const RouterThermalZoneSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    temperatureCelsius: z.number().finite().min(-100).max(250),
  })
  .passthrough();
export type RouterThermalZoneSnapshot = z.infer<typeof RouterThermalZoneSnapshotSchema>;

export const RouterComponentSnapshotSchema = z
  .object({
    battery: RouterBatterySnapshotSchema.optional(),
    charger: RouterChargerSnapshotSchema.optional(),
    thermalZones: z.array(RouterThermalZoneSnapshotSchema).max(64),
  })
  .passthrough();
export type RouterComponentSnapshot = z.infer<typeof RouterComponentSnapshotSchema>;

export const RouterComponentSnapshotUpdateSchema = z
  .object({
    capturedAt: z.string().datetime({ offset: true }),
    snapshot: RouterComponentSnapshotSchema,
  })
  .strict();
export type RouterComponentSnapshotUpdate = z.infer<typeof RouterComponentSnapshotUpdateSchema>;

export const TelemetrySourceEnvelopeSchema = TelemetrySourceMetadataSchema.extend({
  id: z.guid(),
  latestSnapshot: RouterComponentSnapshotSchema.nullable(),
  capturedAt: z.string().datetime().nullable(),
  receivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TelemetrySourceEnvelope = z.infer<typeof TelemetrySourceEnvelopeSchema>;

export const ROUTER_TELEMETRY_METRICS = [
  "glinet_battery_charge_percent",
  "glinet_battery_temperature_celsius",
  "glinet_battery_voltage_volts",
  "glinet_battery_current_amperes",
  "glinet_battery_cycle_count",
  "glinet_battery_charge_count",
  "glinet_battery_present",
  "glinet_battery_abnormal",
  "glinet_battery_abnormal_type",
  "glinet_charger_present",
  "glinet_charger_online",
  "glinet_charger_fastcharge",
  "glinet_charger_charging_status",
  "glinet_charger_input_voltage_limit_volts",
  "glinet_charger_input_current_limit_amperes",
  "glinet_charger_constant_charge_voltage_volts",
  "glinet_charger_constant_charge_current_max_amperes",
  "glinet_thermal_temperature_celsius",
] as const;

export const RouterTelemetryMetricNameSchema = z.enum(ROUTER_TELEMETRY_METRICS);
export type RouterTelemetryMetricName = z.infer<typeof RouterTelemetryMetricNameSchema>;

export const TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES = 10_000;
export const TELEMETRY_HISTORY_MAX_SERIES = 128;
export const TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES = 100_000;

export const TelemetryHistoryPointSchema = z.object({
  timestamp: z.number().finite().nonnegative(),
  value: z.number().finite(),
});
export type TelemetryHistoryPoint = z.infer<typeof TelemetryHistoryPointSchema>;

export const TelemetryHistorySeriesSchema = z.object({
  metric: RouterTelemetryMetricNameSchema,
  labels: z.record(z.string(), z.string()),
  points: z.array(TelemetryHistoryPointSchema).max(TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES),
});
export type TelemetryHistorySeries = z.infer<typeof TelemetryHistorySeriesSchema>;

const addTelemetryHistoryCardinalityIssue = (
  series: readonly { readonly points: readonly unknown[] }[],
  context: z.RefinementCtx,
): void => {
  const totalSamples = series.reduce((total, item) => total + item.points.length, 0);
  if (totalSamples > TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES) {
    context.addIssue({
      code: "custom",
      path: ["series"],
      message: `Telemetry history is limited to ${TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES} total samples.`,
    });
  }
};

export const ComponentTelemetryHistorySchema = z
  .object({
    source: TelemetrySourceMetadataSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
    stepSeconds: z.number().int().min(15),
    series: z.array(TelemetryHistorySeriesSchema).max(TELEMETRY_HISTORY_MAX_SERIES),
  })
  .superRefine((value, context) => {
    addTelemetryHistoryCardinalityIssue(value.series, context);
  });
export type ComponentTelemetryHistory = z.infer<typeof ComponentTelemetryHistorySchema>;

export const THERMAL_METRICS = [
  "booth_cpu_temperature_celsius",
  "glinet_battery_temperature_celsius",
  "glinet_thermal_temperature_celsius",
] as const;

export const ThermalMetricNameSchema = z.enum(THERMAL_METRICS);
export type ThermalMetricName = z.infer<typeof ThermalMetricNameSchema>;

export const ThermalHistorySeriesSchema = z.object({
  metric: ThermalMetricNameSchema,
  labels: z.record(z.string(), z.string()),
  points: z.array(TelemetryHistoryPointSchema).max(TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES),
});
export type ThermalHistorySeries = z.infer<typeof ThermalHistorySeriesSchema>;

export const ThermalHistorySchema = z
  .object({
    boothId: z.string().trim().min(1).max(128),
    source: TelemetrySourceMetadataSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
    stepSeconds: z.number().int().min(15),
    series: z.array(ThermalHistorySeriesSchema).max(TELEMETRY_HISTORY_MAX_SERIES),
  })
  .superRefine((value, context) => {
    if (value.source.boothId !== value.boothId) {
      context.addIssue({
        code: "custom",
        path: ["source", "boothId"],
        message: "Thermal history source must belong to boothId.",
      });
    }
    addTelemetryHistoryCardinalityIssue(value.series, context);
  });
export type ThermalHistory = z.infer<typeof ThermalHistorySchema>;

export const CURRENT_WEATHER_CONDITIONS = [
  "clear_sky",
  "mainly_clear",
  "partly_cloudy",
  "overcast",
  "fog",
  "rime_fog",
  "drizzle",
  "freezing_drizzle",
  "rain",
  "freezing_rain",
  "snowfall",
  "snow_grains",
  "rain_showers",
  "snow_showers",
  "thunderstorm",
  "thunderstorm_with_hail",
  "unknown",
] as const;

export const CurrentWeatherConditionSchema = z.enum(CURRENT_WEATHER_CONDITIONS);
export type CurrentWeatherCondition = z.infer<typeof CurrentWeatherConditionSchema>;

export const CurrentWeatherSchema = z.object({
  boothId: z.string().trim().min(1).max(128),
  source: z.literal("open_meteo"),
  temperatureCelsius: z.number().min(-100).max(100),
  relativeHumidityPercent: z.number().min(0).max(100),
  cloudCoverPercent: z.number().min(0).max(100),
  condition: CurrentWeatherConditionSchema,
  observedAt: z.string().datetime(),
  fetchedAt: z.string().datetime(),
});
export type CurrentWeather = z.infer<typeof CurrentWeatherSchema>;

export const ComponentTelemetryCurrentQuerySchema = z.object({
  boothId: z.string().trim().min(1).max(128).optional(),
  componentId: z.string().trim().min(1).max(128).optional(),
});
export type ComponentTelemetryCurrentQuery = z.infer<typeof ComponentTelemetryCurrentQuerySchema>;

const MAX_TELEMETRY_HISTORY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

const telemetryHistoryRangeFields = {
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  stepSeconds: z.coerce.number().int().min(15).default(60),
};

const addTelemetryHistoryRangeIssues = (
  value: { readonly from: string; readonly to: string; readonly stepSeconds: number },
  context: z.RefinementCtx,
): void => {
  const fromMs = Date.parse(value.from);
  const toMs = Date.parse(value.to);
  if (toMs <= fromMs) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "to must be later than from.",
    });
    return;
  }
  const rangeMs = toMs - fromMs;
  if (rangeMs > MAX_TELEMETRY_HISTORY_RANGE_MS) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "Telemetry history is limited to 31 days.",
    });
  }
  const points = Math.floor(rangeMs / (value.stepSeconds * 1000)) + 1;
  if (points > TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES) {
    context.addIssue({
      code: "custom",
      path: ["stepSeconds"],
      message: "Telemetry history is limited to 10000 points per series.",
    });
  }
};

export const ComponentTelemetryHistoryQuerySchema = z
  .object({
    boothId: z.string().trim().min(1).max(128),
    componentId: z.string().trim().min(1).max(128),
    ...telemetryHistoryRangeFields,
  })
  .superRefine(addTelemetryHistoryRangeIssues);
export type ComponentTelemetryHistoryQuery = z.infer<typeof ComponentTelemetryHistoryQuerySchema>;

export const ThermalHistoryQuerySchema = z
  .object({
    boothId: z.string().trim().min(1).max(128),
    componentId: z.string().trim().min(1).max(128).optional(),
    ...telemetryHistoryRangeFields,
  })
  .superRefine(addTelemetryHistoryRangeIssues);
export type ThermalHistoryQuery = z.infer<typeof ThermalHistoryQuerySchema>;

export const CurrentWeatherQuerySchema = z.object({
  boothId: z.string().trim().min(1).max(128),
});
export type CurrentWeatherQuery = z.infer<typeof CurrentWeatherQuerySchema>;

// Live system snapshot pushed by the booth via `PUT /v1/system`. Mirrors the
// Rust `booth-hal::SystemSnapshot` struct as it appears on the wire (camelCase
// via `#[serde(rename_all = "camelCase")]`). Every top-level snapshot field
// is optional so the schema is forward-compatible with new metrics and
// tolerates host adapters that can only fill in a subset of the fields.
// Disk and network *entries* still require their identifying field
// (`mountPoint` / `interface`) plus core counters, because an entry without
// those would have no meaning — adapters that can't supply them should omit
// the entry rather than emit a partial one. Every object is `.passthrough()`
// so unknown future keys are preserved end-to-end.
//
// The envelope-level `boothId` lives on `BoothSystemSnapshotEnvelopeSchema`
// below — it is NOT a snapshot field. Likewise the server stamps `receivedAt`
// when it accepts the PUT; the booth does not include a client-side timestamp.
export const BoothCpuStatsSchema = z
  .object({
    usageRatio: z.number().min(0).max(1).nullable().optional(),
    perCoreUsageRatio: z.array(z.number().min(0).max(1)).nullable().optional(),
    physicalCores: z.number().int().nonnegative().nullable().optional(),
    loadAvg1m: z.number().nullable().optional(),
    loadAvg5m: z.number().nullable().optional(),
    loadAvg15m: z.number().nullable().optional(),
  })
  .passthrough();
export type BoothCpuStats = z.infer<typeof BoothCpuStatsSchema>;

export const BoothMemoryStatsSchema = z
  .object({
    totalBytes: z.number().nonnegative().nullable().optional(),
    usedBytes: z.number().nonnegative().nullable().optional(),
    swapTotalBytes: z.number().nonnegative().nullable().optional(),
    swapUsedBytes: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();
export type BoothMemoryStats = z.infer<typeof BoothMemoryStatsSchema>;

export const BoothDiskStatsSchema = z
  .object({
    mountPoint: z.string(),
    filesystem: z.string().nullable().optional(),
    totalBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
  })
  .passthrough();
export type BoothDiskStats = z.infer<typeof BoothDiskStatsSchema>;

export const BoothNetworkStatsSchema = z
  .object({
    interface: z.string(),
    receiveBytesTotal: z.number().nonnegative(),
    transmitBytesTotal: z.number().nonnegative(),
    addresses: z.array(z.string()).optional(),
  })
  .passthrough();
export type BoothNetworkStats = z.infer<typeof BoothNetworkStatsSchema>;

export const BoothProcessStatsSchema = z
  .object({
    residentBytes: z.number().nonnegative().nullable().optional(),
    virtualBytes: z.number().nonnegative().nullable().optional(),
    openFds: z.number().nonnegative().nullable().optional(),
    threads: z.number().nonnegative().nullable().optional(),
    uptimeSeconds: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();
export type BoothProcessStats = z.infer<typeof BoothProcessStatsSchema>;

export const BoothAudioStatsSchema = z
  .object({
    inputDevice: z.string().nullable().optional(),
    outputDevice: z.string().nullable().optional(),
    sampleRateHz: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type BoothAudioStats = z.infer<typeof BoothAudioStatsSchema>;

export const BoothTailscaleStatsSchema = z
  .object({
    connected: z.boolean().nullable().optional(),
    peerCount: z.number().int().nonnegative().nullable().optional(),
    hostname: z.string().nullable().optional(),
    exitNode: z.string().nullable().optional(),
  })
  .passthrough();
export type BoothTailscaleStats = z.infer<typeof BoothTailscaleStatsSchema>;

// Linux PWM cooling-fan command and optional tachometer feedback. Commanded
// state describes the kernel request; only `rpm` confirms measured rotor speed.
export const BoothFanStatsSchema = z
  .object({
    commandedOn: z.boolean().nullable().optional(),
    pwmRatio: z.number().min(0).max(1).nullable().optional(),
    rpm: z.number().int().nonnegative().nullable().optional(),
    coolingState: z.number().int().nonnegative().nullable().optional(),
    maxCoolingState: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type BoothFanStats = z.infer<typeof BoothFanStatsSchema>;

// Mirrors the six boolean Pi throttling flags reported by `vcgencmd
// get_throttled`. Adapters that can't read these (non-Pi hosts) omit the
// whole object.
export const BoothThrottlingFlagsSchema = z
  .object({
    undervoltage: z.boolean().nullable().optional(),
    armFreqCapped: z.boolean().nullable().optional(),
    throttled: z.boolean().nullable().optional(),
    softTempLimit: z.boolean().nullable().optional(),
    undervoltageOccurred: z.boolean().nullable().optional(),
    throttledOccurred: z.boolean().nullable().optional(),
  })
  .passthrough();
export type BoothThrottlingFlags = z.infer<typeof BoothThrottlingFlagsSchema>;

export const BoothSystemSnapshotSchema = z
  .object({
    cpu: BoothCpuStatsSchema.nullable().optional(),
    temperatureCelsius: z.number().nullable().optional(),
    memory: BoothMemoryStatsSchema.nullable().optional(),
    disks: z.array(BoothDiskStatsSchema).nullable().optional(),
    networks: z.array(BoothNetworkStatsSchema).nullable().optional(),
    uptimeSeconds: z.number().nonnegative().nullable().optional(),
    process: BoothProcessStatsSchema.nullable().optional(),
    audio: BoothAudioStatsSchema.nullable().optional(),
    tailscale: BoothTailscaleStatsSchema.nullable().optional(),
    fan: BoothFanStatsSchema.nullable().optional(),
    throttling: BoothThrottlingFlagsSchema.nullable().optional(),
    runtimeMode: RuntimeModeSchema.nullable().optional(),
  })
  .passthrough();
export type BoothSystemSnapshot = z.infer<typeof BoothSystemSnapshotSchema>;

export type SystemHealthSeverity = "ok" | "warn" | "crit";

export const SYSTEM_HEALTH_THRESHOLDS = {
  temperatureWarnCelsius: 60,
  temperatureCriticalCelsius: 75,
  memoryWarnRatio: 0.85,
  memoryCriticalRatio: 0.95,
} as const;

export const systemTemperatureSeverity = (
  value: number | null | undefined,
): SystemHealthSeverity => {
  if (typeof value !== "number") return "ok";
  if (value >= SYSTEM_HEALTH_THRESHOLDS.temperatureCriticalCelsius) return "crit";
  if (value >= SYSTEM_HEALTH_THRESHOLDS.temperatureWarnCelsius) return "warn";
  return "ok";
};

export const systemMemorySeverity = (
  used: number | null | undefined,
  total: number | null | undefined,
): SystemHealthSeverity => {
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) return "ok";
  const ratio = used / total;
  if (ratio >= SYSTEM_HEALTH_THRESHOLDS.memoryCriticalRatio) return "crit";
  if (ratio >= SYSTEM_HEALTH_THRESHOLDS.memoryWarnRatio) return "warn";
  return "ok";
};

export const systemLoadSeverity = (
  value: number | null | undefined,
  cores: number | null | undefined,
): SystemHealthSeverity => {
  if (typeof value !== "number") return "ok";
  const reference = typeof cores === "number" && cores > 0 ? cores : 1;
  if (value >= reference * 2) return "crit";
  if (value >= reference) return "warn";
  return "ok";
};

export const activeThrottlingLabels = (
  flags: BoothThrottlingFlags | null | undefined,
): string[] => {
  if (!flags) return [];
  const labels: string[] = [];
  if (flags.undervoltage) labels.push("under-voltage");
  if (flags.armFreqCapped) labels.push("arm-freq-capped");
  if (flags.throttled) labels.push("throttled");
  if (flags.softTempLimit) labels.push("soft-temp-limit");
  if (flags.undervoltageOccurred) labels.push("under-voltage-occurred");
  if (flags.throttledOccurred) labels.push("throttled-occurred");
  return labels;
};

export const aggregateSystemHealthSeverity = (
  snapshot: BoothSystemSnapshot | null | undefined,
): SystemHealthSeverity => {
  if (!snapshot) return "ok";
  const cpu = snapshot.cpu;
  const memory = snapshot.memory;
  const cores =
    typeof cpu?.physicalCores === "number" && cpu.physicalCores > 0
      ? cpu.physicalCores
      : Array.isArray(cpu?.perCoreUsageRatio) && cpu.perCoreUsageRatio.length > 0
        ? cpu.perCoreUsageRatio.length
        : null;
  const severities: SystemHealthSeverity[] = [
    systemTemperatureSeverity(snapshot.temperatureCelsius),
    systemMemorySeverity(memory?.usedBytes, memory?.totalBytes),
    systemLoadSeverity(cpu?.loadAvg1m, cores),
    activeThrottlingLabels(snapshot.throttling).length > 0 ? "warn" : "ok",
    snapshot.tailscale?.connected === false ? "crit" : "ok",
  ];
  return severities.reduce<SystemHealthSeverity>(
    (current, severity) =>
      severity === "crit" ? "crit" : severity === "warn" && current === "ok" ? "warn" : current,
    "ok",
  );
};

// `PUT /v1/system` accepts the snapshot body. The `receivedAt` field is
// stamped server-side and echoed back in responses + WS broadcasts.
export const BoothSystemSnapshotEnvelopeSchema = z.object({
  boothId: z.string(),
  snapshot: BoothSystemSnapshotSchema,
  receivedAt: z.string().datetime(),
  // Running version of the `telephone-booth` Rust client that produced the
  // snapshot. Optional + nullable so older booths still upload.
  version: z.string().min(1).max(BOOTH_CLIENT_VERSION_MAX).nullable().optional(),
});
export type BoothSystemSnapshotEnvelope = z.infer<typeof BoothSystemSnapshotEnvelopeSchema>;

// -----------------------------------------------------------------------------
// Installations. An installation is a named era of the booth — one run of the
// art piece. At most one is "active" (`endedAt === null`) at a time — none
// between an era ending and the next booth write — and every booth write is
// tagged with it. Ending an installation freezes a `summary` so
// the history list renders without re-aggregating the event table per row.
//
// Read endpoints accept an `installationId` scope: omitted means the active
// installation, a uuid selects a historical one, and "all" spans every era.
// -----------------------------------------------------------------------------

// The literal used to opt out of installation scoping on read endpoints.
export const INSTALLATION_SCOPE_ALL = "all";

export const InstallationScopeSchema = z.union([z.guid(), z.literal(INSTALLATION_SCOPE_ALL)]);
export type InstallationScope = z.infer<typeof InstallationScopeSchema>;

// Counters frozen when an installation ends. Deliberately a small, stable
// subset of `StatsOverview` — this is persisted to a JSON column, so it must
// stay cheap to compute and safe to read back from old rows.
export const InstallationSummarySchema = z.object({
  calls: z.number().int().nonnegative(),
  // "messages" is deliberately the operator-playable approved subset.
  messages: z.number().int().nonnegative(),
  allRecordings: z.number().int().nonnegative().default(0),
  byStatus: z.record(z.string(), z.number().int().nonnegative()).default({}),
  // Kept while archived clients transition to the unambiguous `messages`
  // (approved) and `allRecordings` fields.
  messagesApproved: z.number().int().nonnegative(),
  messagesRejected: z.number().int().nonnegative(),
  questions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  recordedMs: z.number().int().nonnegative(),
  // Bounds of the era's *booth event* stream, which is what the booth emits
  // continuously while it is running. Null when the era recorded no events —
  // an era can still hold messages or questions in that case, so read these as
  // "when the booth was live", not as "whether anything happened".
  firstActivityAt: z.string().datetime().nullable(),
  lastActivityAt: z.string().datetime().nullable(),
});
export type InstallationSummary = z.infer<typeof InstallationSummarySchema>;

export const InstallationSchema = z.object({
  id: z.guid(),
  name: z.string(),
  notes: z.string().nullable(),
  location: z.string().nullable(),
  defaultTranscriptionLanguage: DefaultTranscriptionLanguageSchema.nullable().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  endedById: z.string().nullable(),
  // Frozen at end time. Null while the installation is still active — live
  // numbers come from `/v1/stats/*` scoped to this installation instead.
  summary: InstallationSummarySchema.nullable(),
  createdAt: z.string().datetime(),
  // Convenience flag so clients don't have to re-derive `endedAt === null`.
  isActive: z.boolean(),
});
export type Installation = z.infer<typeof InstallationSchema>;

const installationMetadataFields = {
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  defaultTranscriptionLanguage: DefaultTranscriptionLanguageSchema.nullable().optional(),
};

export const InstallationCreateSchema = z.object({
  ...installationMetadataFields,
  // Copy the previous installation's active questions into the new one,
  // re-using the same audio `File` rows so nothing is re-uploaded. Defaults to
  // false: a new installation is a blank slate unless asked otherwise.
  copyQuestions: z.boolean().default(false),
});
export type InstallationCreate = z.infer<typeof InstallationCreateSchema>;

export const InstallationUpdateSchema = z.object(installationMetadataFields).partial();
export type InstallationUpdate = z.infer<typeof InstallationUpdateSchema>;

export const InstallationEndSchema = z.object({
  // Optional annotation edits applied as part of closing the books, so the
  // operator can record where the booth stood and how it went without a
  // second request. Renaming is not part of this contract — use PATCH.
  notes: z.string().trim().max(2000).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
});
export type InstallationEnd = z.infer<typeof InstallationEndSchema>;

// Hard purge is irreversible, so the caller must echo the installation's exact
// name back. This is a deliberate speed bump, not a security control.
export const InstallationPurgeSchema = z.object({
  confirmName: z.string(),
});
export type InstallationPurge = z.infer<typeof InstallationPurgeSchema>;

export const InstallationPurgeResultSchema = z.object({
  installationId: z.guid(),
  rows: z.record(z.string(), z.number().int().nonnegative()),
  blobsDeleted: z.number().int().nonnegative(),
  // Blobs still referenced by a surviving File row (e.g. questions copied
  // forward into a later installation) are kept, not orphaned.
  blobsRetained: z.number().int().nonnegative(),
  blobFailures: z.array(z.string()),
});
export type InstallationPurgeResult = z.infer<typeof InstallationPurgeResultSchema>;

// -----------------------------------------------------------------------------
// Operator-authenticated on-device message processing.
// -----------------------------------------------------------------------------

export const MessageProcessingStepSchema = z.enum([
  "transcription",
  "translation",
  "moderation",
  "review",
]);
export type MessageProcessingStep = z.infer<typeof MessageProcessingStepSchema>;

export const MessageProcessingCapabilitiesSchema = z
  .array(MessageProcessingStepSchema)
  .min(1)
  .max(4)
  .default(["transcription", "translation", "moderation", "review"]);
export type MessageProcessingCapabilities = z.infer<typeof MessageProcessingCapabilitiesSchema>;

export const MessageProcessingClaimRequestSchema = z.object({
  capabilities: MessageProcessingCapabilitiesSchema,
  leaseSeconds: z.number().int().min(30).max(900).default(300),
});
export type MessageProcessingClaimRequest = z.infer<typeof MessageProcessingClaimRequestSchema>;

export const MessageProcessingClaimSchema = z.object({
  message: MessageSchema,
  needs: z.array(MessageProcessingStepSchema).min(1),
  leaseToken: z.string().min(32),
  leaseExpiresAt: z.string().datetime(),
  defaultTranscriptionLanguage: DefaultTranscriptionLanguageSchema.nullable(),
});
export type MessageProcessingClaim = z.infer<typeof MessageProcessingClaimSchema>;

export const MessageProcessingClaimResponseSchema = z.object({
  claim: MessageProcessingClaimSchema.nullable(),
});
export type MessageProcessingClaimResponse = z.infer<typeof MessageProcessingClaimResponseSchema>;

export const MessageProcessingSummarySchema = z.object({
  queued: z.number().int().nonnegative(),
  leased: z.number().int().nonnegative(),
  terminal: z.number().int().nonnegative(),
  needs: z.object({
    transcription: z.number().int().nonnegative(),
    translation: z.number().int().nonnegative(),
    moderation: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  }),
  generatedAt: z.string().datetime(),
});
export type MessageProcessingSummary = z.infer<typeof MessageProcessingSummarySchema>;

const ProcessingTranslationSubmitSchema = z.object({
  transcriptionId: z.guid().optional(),
  expectedTranslationSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  translatedText: z.string().trim().min(1).max(20_000),
  translatedLanguage: Bcp47LanguageTagSchema.optional(),
  model: z.string().trim().min(1).max(128).nullable().optional(),
});

const ProcessingModerationSubmitSchema = z.object({
  inputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  flagged: z.boolean(),
  recommendation: ModerationRecommendationSchema,
  maxScore: z.number().min(0).max(1),
  categories: z.record(z.string(), z.number()).optional(),
  reasonSummary: z.string().max(2000).nullable().optional(),
  model: z.string().trim().min(1).max(128).nullable().optional(),
});

export const MessageProcessingCompleteSchema = z
  .object({
    leaseToken: z.string().min(32),
    transcription: TranscriptionSubmitSchema.omit({ processDownstream: true }).optional(),
    translation: ProcessingTranslationSubmitSchema.optional(),
    moderation: ProcessingModerationSubmitSchema.optional(),
    review: z
      .object({
        classification: MessageReviewClassificationSchema,
        recommendation: MessageReviewRecommendationSchema,
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.transcription !== undefined ||
      value.translation !== undefined ||
      value.moderation !== undefined ||
      value.review !== undefined,
    { message: "At least one processing result is required." },
  );
export type MessageProcessingComplete = z.infer<typeof MessageProcessingCompleteSchema>;

export const MessageProcessingLeaseTokenSchema = z.object({
  leaseToken: z.string().min(32),
});

export const MessageProcessingHeartbeatSchema = MessageProcessingLeaseTokenSchema.extend({
  leaseSeconds: z.number().int().min(30).max(900).default(300),
});
export type MessageProcessingHeartbeat = z.infer<typeof MessageProcessingHeartbeatSchema>;

export const MessageProcessingFailSchema = MessageProcessingLeaseTokenSchema.extend({
  errorCode: z.string().trim().min(1).max(128),
  errorMessage: z.string().trim().max(2000).optional(),
});
export type MessageProcessingFail = z.infer<typeof MessageProcessingFailSchema>;

// Discriminated union for the `/v1/ws/status` socket. The legacy payload
// shape (a bare `BoothStatus`) is migrated to `{ kind: "status", status }`
// in the `op-api` PR.
export const WsEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    status: BoothStatusSchema,
  }),
  z.object({
    kind: z.literal("system"),
    boothId: z.string(),
    snapshot: BoothSystemSnapshotSchema,
    receivedAt: z.string().datetime(),
    version: z.string().min(1).max(BOOTH_CLIENT_VERSION_MAX).nullable().optional(),
  }),
  z.object({
    kind: z.literal("message"),
    message: MessageSchema,
  }),
  // Push-mode work notification. The Transcription app (macOS + iOS)
  // subscribes to the status socket and reacts to these by running the named
  // steps locally, then POSTing results back to the worker callback endpoints.
  // Carries no secrets (no SAS URLs / transcript text) — the worker fetches
  // what it needs over its authenticated REST calls.
  z.object({
    kind: z.literal("work"),
    messageId: z.string(),
    needs: z.array(z.enum(["transcription", "translation", "moderation"])).min(1),
  }),
  // Emitted when an installation starts or ends. Clients use it to re-scope
  // their queries to the new active era without waiting for a reload.
  z.object({
    kind: z.literal("installation"),
    installation: InstallationSchema,
  }),
]);
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

// -----------------------------------------------------------------------------
// Mobile devices: APNs push registry for the operator mobile app.
// -----------------------------------------------------------------------------

export const MobileDevicePlatformSchema = z.enum([
  "ios",
  "ipados",
  "macos",
  "watchos",
  "tvos",
  "visionos",
]);
export type MobileDevicePlatform = z.infer<typeof MobileDevicePlatformSchema>;

export const MobileDevicePreferencesSchema = z.object({
  callStarted: z.boolean().default(true),
  messageReceived: z.boolean().default(true),
  messageFlagged: z.boolean().default(true),
  moderationQueueHigh: z.boolean().default(false),
});
export type MobileDevicePreferences = z.infer<typeof MobileDevicePreferencesSchema>;

export const MobileDeviceSchema = z.object({
  id: z.guid(),
  apnsToken: z.string().min(32),
  platform: MobileDevicePlatformSchema,
  deviceName: z.string().nullable(),
  preferences: MobileDevicePreferencesSchema,
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type MobileDevice = z.infer<typeof MobileDeviceSchema>;

export const RegisterMobileDeviceRequestSchema = z.object({
  apnsToken: z.string().min(32),
  platform: MobileDevicePlatformSchema,
  deviceName: z.string().min(1).max(120).nullish(),
  preferences: MobileDevicePreferencesSchema.partial().optional(),
});
export type RegisterMobileDeviceRequest = z.infer<typeof RegisterMobileDeviceRequestSchema>;

export const UpdateMobileDevicePreferencesSchema = z.object({
  deviceName: z.string().min(1).max(120).nullish(),
  preferences: MobileDevicePreferencesSchema.partial().optional(),
});
export type UpdateMobileDevicePreferences = z.infer<typeof UpdateMobileDevicePreferencesSchema>;

// -----------------------------------------------------------------------------
// Usage statistics overview. See packages/api/src/routes/stats.ts (the
// `/v1/stats/overview` handler) for the producer and packages/web/src/features
// /stats for the primary consumer. Mobile app mirrors these structures.
//
// All bucketing is done in server UTC; clients are expected to reformat for
// the device locale. The `timezone` field on the envelope makes that
// explicit so consumers don't have to guess.
// -----------------------------------------------------------------------------

export const StatsWindowSchema = z.enum(["24h", "7d", "30d", "all"]);
export type StatsWindow = z.infer<typeof StatsWindowSchema>;

export const STATS_WINDOW_VALUES = StatsWindowSchema.options;

// Map a window enum to a millisecond duration, or null for "all" (no lower
// bound). Exported so the API and tests share one source of truth.
export const statsWindowDurationMs = (window: StatsWindow): number | null => {
  switch (window) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "all":
      return null;
  }
};

export const StatsCallsPerDaySchema = z.object({
  date: z.string(), // YYYY-MM-DD (UTC)
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});
export type StatsCallsPerDay = z.infer<typeof StatsCallsPerDaySchema>;

export const StatsHourlyBucketSchema = z.object({
  hour: z.number().int().min(0).max(23),
  calls: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
});
export type StatsHourlyBucket = z.infer<typeof StatsHourlyBucketSchema>;

export const StatsTopQuestionSchema = z.object({
  questionId: z.guid(),
  prompt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().datetime().nullable(),
  retiredAt: z.string().datetime().nullable(),
});
export type StatsTopQuestion = z.infer<typeof StatsTopQuestionSchema>;

export const StatsBoothBreakdownSchema = z.object({
  boothId: z.string(),
  calls: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type StatsBoothBreakdown = z.infer<typeof StatsBoothBreakdownSchema>;

// Day-of-week index: 0 = Sunday, 6 = Saturday (matches JS Date.getUTCDay()).
export const StatsBusiestSchema = z.object({
  hour: z.number().int().min(0).max(23).nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
});
export type StatsBusiest = z.infer<typeof StatsBusiestSchema>;

export const StatsOverviewSchema = z.object({
  window: z.union([StatsWindowSchema, z.literal("custom")]),
  rangeStart: z.string().datetime().nullable(),
  rangeEnd: z.string().datetime(),
  generatedAt: z.string().datetime(),
  timezone: z.literal("UTC"),
  calls: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    averageDurationMs: z.number().nonnegative().nullable(),
    longestDurationMs: z.number().nonnegative().nullable(),
    // Keyed by CallOutcome string. The producer emits the raw outcome value
    // verbatim — new server-side enum members appear as their own keys
    // rather than being normalised, so clients should render unrecognised
    // keys directly. The literal "unknown" key is only emitted when the DB
    // value was null.
    outcomes: z.record(z.string(), z.number().int().nonnegative()),
    perDay: z.array(StatsCallsPerDaySchema),
  }),
  messages: z.object({
    // `total` remains for older clients and has the same approved/playable
    // meaning as `approved`; use the explicit fields in new clients.
    total: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative().optional(),
    allRecordings: z.number().int().nonnegative().optional(),
    // Keyed by MessageStatus string. As with `outcomes`, unrecognised
    // server-side values appear under their raw key — clients should
    // render whatever key arrives rather than special-casing "unknown".
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    averageDurationMs: z.number().nonnegative().nullable(),
  }),
  playback: z.object({
    // Count of state_transition events landing on `playing_message`. The
    // booth telemetry does not currently carry a message id on transitions
    // so we cannot report uniqueMessagesPlayed yet.
    totalPlaybacks: z.number().int().nonnegative(),
  }),
  pickupsHangups: z.object({
    pickups: z.number().int().nonnegative(),
    hangups: z.number().int().nonnegative(),
    // 10-entry zero-filled record keyed "0".."9".
    digitsDialed: z.record(z.string(), z.number().int().nonnegative()),
  }),
  uploads: z.object({
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    // null when there were zero attempts in the window.
    failureRate: z.number().min(0).max(1).nullable(),
  }),
  topQuestions: z.array(StatsTopQuestionSchema),
  hourly: z.array(StatsHourlyBucketSchema),
  busiest: StatsBusiestSchema,
  lastActivityAt: z.string().datetime().nullable(),
  boothBreakdown: z.array(StatsBoothBreakdownSchema),
});
export type StatsOverview = z.infer<typeof StatsOverviewSchema>;

// -----------------------------------------------------------------------------
// Saved metric filters. A filter captures a named time selection an operator
// can re-apply later. It is either a preset `window`, or a custom range
// (`window: null`). For custom ranges, `start === null` means "from the
// beginning" and `end === null` means "now" (always current). A preset window
// and a start/end range are mutually exclusive.
// -----------------------------------------------------------------------------

export const MetricFilterSchema = z.object({
  id: z.guid(),
  name: z.string(),
  window: StatsWindowSchema.nullable(),
  start: z.string().datetime().nullable(),
  end: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MetricFilter = z.infer<typeof MetricFilterSchema>;

const metricFilterFields = {
  name: z.string().trim().min(1).max(80),
  // `window` is a required key so an explicit custom range (`window: null`) is
  // distinguishable from an accidentally empty payload (key omitted, which is
  // rejected). A preset value selects that window; `null` means "custom range"
  // and is qualified by the optional start/end bounds below.
  window: StatsWindowSchema.nullable(),
  start: z.string().datetime().nullable().optional(),
  end: z.string().datetime().nullable().optional(),
};

type MetricFilterInput = {
  name: string;
  window: StatsWindow | null;
  start?: string | null | undefined;
  end?: string | null | undefined;
};

// A preset window is a complete selection on its own; a custom range
// (`window: null`) may carry start/end bounds, where `null` means open-ended
// ("from the beginning" / "through now"). A preset window and an explicit
// range are mutually exclusive.
const presetExcludesRange = (value: MetricFilterInput): boolean => {
  if (value.window === null) return true;
  return (value.start ?? null) === null && (value.end ?? null) === null;
};

const rangeOrdered = (value: MetricFilterInput): boolean => {
  if (!value.start || !value.end) return true;
  return new Date(value.start).getTime() <= new Date(value.end).getTime();
};

export const MetricFilterCreateSchema = z
  .object(metricFilterFields)
  .refine((value): boolean => presetExcludesRange(value), {
    message: "A preset window cannot be combined with a custom start/end range.",
    path: ["window"],
  })
  .refine((value): boolean => rangeOrdered(value), {
    message: "start must be on or before end.",
    path: ["start"],
  });
export type MetricFilterCreate = z.infer<typeof MetricFilterCreateSchema>;

export const MetricFilterUpdateSchema = MetricFilterCreateSchema;
export type MetricFilterUpdate = z.infer<typeof MetricFilterUpdateSchema>;

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
// Every write action against the operator API is recorded with the actor, the
// client IP, and a timestamp. See docs/audit-log.md.

export const AuditActorTypeSchema = z.enum(["operator", "apiToken", "anonymous", "system"]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.guid(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  actorUserId: z.string().nullable(),
  actorTokenId: z.string().nullable(),
  // Human-readable snapshot of the actor taken at write time (operator email,
  // or `token:<name>`). Survives the referenced row being deleted or revoked.
  actorLabel: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  method: z.string(),
  path: z.string(),
  statusCode: z.number().int(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogPageSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;
