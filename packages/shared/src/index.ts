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

export const AiProviderSchema = z.enum(["openai", "mac_app", "disabled"]);
export type AiProvider = z.infer<typeof AiProviderSchema>;

export const TranscriptionSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
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
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  transcriptionId: z.string().uuid().nullable(),
  provider: AiProviderSchema,
  model: z.string().nullable(),
  status: TranscriptionStatusSchema,
  flagged: z.boolean().nullable(),
  recommendation: ModerationRecommendationSchema.nullable(),
  maxScore: z.number().min(0).max(1).nullable(),
  categories: z.record(z.number()).nullable(),
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
  currentQuestionId: z.string().uuid().nullable().optional(),
  currentMessageId: z.string().uuid().nullable().optional(),
  lastError: z.string().nullable().optional(),
  runtimeMode: RuntimeModeSchema.nullable().optional(),
});
export type BoothStatus = z.infer<typeof BoothStatusSchema>;

export const StatusUpdateSchema = BoothStatusSchema.omit({ updatedAt: true }).extend({
  updatedAt: z.string().datetime().optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

export const QuestionSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).max(280),
  createdAt: z.string().datetime(),
  audio: AudioRefSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionCreateSchema = z.object({
  prompt: z.string().min(1).max(280),
  audioFileId: z.string().uuid(),
});
export type QuestionCreate = z.infer<typeof QuestionCreateSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  status: MessageStatusSchema,
  questionId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  receivedAt: z.string().datetime().nullable().optional(),
  audio: AudioRefSchema,
  latestTranscription: TranscriptionSchema.nullable().optional(),
  latestModeration: ModerationSchema.nullable().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// 5 minutes — generous upper bound for booth recordings.
export const MAX_AUDIO_DURATION_MS = 300_000;

export const MessageCreateSchema = z.object({
  questionId: z.string().uuid().optional(),
  durationMs: z.number().int().positive().max(MAX_AUDIO_DURATION_MS),
  sha256: Sha256Schema,
});
export type MessageCreate = z.infer<typeof MessageCreateSchema>;

export const MessageInitiatedSchema = z.object({
  id: z.string().uuid(),
  uploadUrl: z.string().url(),
  blobName: z.string().min(1),
});
export type MessageInitiated = z.infer<typeof MessageInitiatedSchema>;

export const MessageCompleteSchema = z.object({
  id: z.string().uuid(),
  status: z.literal("received"),
  receivedAt: z.string().datetime(),
});
export type MessageComplete = z.infer<typeof MessageCompleteSchema>;

export const UploadSasRequestSchema = z.object({
  kind: z.enum(["message", "question-audio"]),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive(),
  contentType: z.literal("audio/flac"),
});
export type UploadSasRequest = z.infer<typeof UploadSasRequestSchema>;

export const UploadSlotSchema = z.object({
  uploadUrl: z.string().url(),
  blobName: z.string().min(1),
  expiresAt: z.string().datetime(),
  audioFileId: z.string().uuid().optional(),
});
export type UploadSlot = z.infer<typeof UploadSlotSchema>;

export const OperatorMeSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  groups: z.array(z.string()),
  picture: z.string().url().optional(),
  providerName: z.string(),
});
export type OperatorMe = z.infer<typeof OperatorMeSchema>;

export const CreateApiTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequestSchema>;

export const ApiTokenSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  last4: z.string().length(4),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
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

// Mirrors the Rust `CallOutcome` enum. Operator UI uses these strings to
// label session rows; Grafana uses them as `outcome` labels on
// `booth_calls_total`.
export const CallOutcomeSchema = z.enum([
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
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const BoothEventSchema = z.object({
  eventId: z.string().min(1).max(128),
  boothId: z.string().min(1).max(64),
  bootId: z.string().uuid(),
  type: BoothEventTypeSchema,
  occurredAt: z.string().datetime(),
  sessionId: z.string().uuid().nullable().optional(),
  recordingId: z.string().min(1).max(128).nullable().optional(),
  payload: z.unknown().optional(),
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
  id: z.string().uuid(),
  boothId: z.string(),
  bootId: z.string().uuid(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  digitsDialed: z.string().nullable(),
  outcome: CallOutcomeSchema.nullable(),
  recordingId: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
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
    throttling: BoothThrottlingFlagsSchema.nullable().optional(),
    runtimeMode: RuntimeModeSchema.nullable().optional(),
  })
  .passthrough();
export type BoothSystemSnapshot = z.infer<typeof BoothSystemSnapshotSchema>;

// `PUT /v1/system` accepts the snapshot body. The `receivedAt` field is
// stamped server-side and echoed back in responses + WS broadcasts.
export const BoothSystemSnapshotEnvelopeSchema = z.object({
  boothId: z.string(),
  snapshot: BoothSystemSnapshotSchema,
  receivedAt: z.string().datetime(),
});
export type BoothSystemSnapshotEnvelope = z.infer<typeof BoothSystemSnapshotEnvelopeSchema>;

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
  }),
  z.object({
    kind: z.literal("message"),
    message: MessageSchema,
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
  id: z.string().uuid(),
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
  questionId: z.string().uuid(),
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
  window: StatsWindowSchema,
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
    outcomes: z.record(z.number().int().nonnegative()),
    perDay: z.array(StatsCallsPerDaySchema),
  }),
  messages: z.object({
    total: z.number().int().nonnegative(),
    // Keyed by MessageStatus string. As with `outcomes`, unrecognised
    // server-side values appear under their raw key — clients should
    // render whatever key arrives rather than special-casing "unknown".
    byStatus: z.record(z.number().int().nonnegative()),
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
    digitsDialed: z.record(z.number().int().nonnegative()),
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
