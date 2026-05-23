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

export const MessageStatusSchema = z.enum(["uploading", "received", "pending", "approved", "rejected"]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AudioRefSchema = z.object({
  url: z.string().url(),
  sha256: Sha256Schema,
  durationMs: z.number().int().positive().nullable(),
});
export type AudioRef = z.infer<typeof AudioRefSchema>;

export const BoothStatusSchema = z.object({
  state: BoothStateSchema,
  updatedAt: z.string().datetime(),
  currentQuestionId: z.string().uuid().nullable().optional(),
  currentMessageId: z.string().uuid().nullable().optional(),
  lastError: z.string().nullable().optional(),
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
});
export type Message = z.infer<typeof MessageSchema>;

export const MessageCreateSchema = z.object({
  questionId: z.string().uuid().optional(),
  durationMs: z.number().int().positive(),
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

export const ApiTokenCreatedSchema = ApiTokenSchema.omit({ lastUsedAt: true, revokedAt: true }).extend({
  plaintext: z.string(),
});
export type ApiTokenCreated = z.infer<typeof ApiTokenCreatedSchema>;

export const ApiTokenUsageBucketSchema = z.object({
  date: z.string(),
  count: z.number().int().nonnegative(),
});
export type ApiTokenUsageBucket = z.infer<typeof ApiTokenUsageBucketSchema>;
