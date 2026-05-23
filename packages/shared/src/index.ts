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

export const MessageStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const AudioRefSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  durationMs: z.number().int().positive().nullable().optional(),
  contentType: z.literal("audio/flac"),
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

export const QuestionSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).max(280),
  createdAt: z.string().datetime(),
  audio: AudioRefSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  status: MessageStatusSchema,
  questionId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  audio: AudioRefSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const UploadSlotSchema = z.object({
  id: z.string().uuid(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
  contentType: z.literal("audio/flac"),
});
export type UploadSlot = z.infer<typeof UploadSlotSchema>;

export const OperatorMeSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  groups: z.array(z.string()),
  providerName: z.string(),
});
export type OperatorMe = z.infer<typeof OperatorMeSchema>;
