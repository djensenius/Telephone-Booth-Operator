import type {
  BoothEvent as PrismaBoothEvent,
  BoothStatusSnapshot,
  CallSession as PrismaCallSession,
  File,
  Message,
  Moderation as PrismaModeration,
  Question,
  Transcription as PrismaTranscription,
} from "@prisma/client";
import type {
  AiProvider,
  BoothEventRecord,
  CallOutcome,
  CallSession as CallSessionPayload,
  Message as MessagePayload,
  Moderation as ModerationPayload,
  Question as QuestionPayload,
  Transcription as TranscriptionPayload,
} from "@telephone-booth-operator/shared";
import type { BoothStatusEvent } from "./broadcaster.js";
import { generateSasUrl } from "./azure-blob.js";

export type WithAudio<T> = T & { audio: File };

const iso = (date: Date): string => date.toISOString();

export const audioRef = (file: File) => ({
  url: generateSasUrl(file.blobKey, { permissions: "r" }).url,
  sha256: file.sha256,
  durationMs: file.durationMs,
});

export const serializeQuestion = (question: WithAudio<Question>): QuestionPayload => ({
  id: question.id,
  prompt: question.prompt,
  createdAt: iso(question.createdAt),
  audio: audioRef(question.audio),
});

export const serializeTranscription = (row: PrismaTranscription): TranscriptionPayload => ({
  id: row.id,
  messageId: row.messageId,
  provider: row.provider as AiProvider,
  model: row.model,
  status: row.status,
  text: row.text,
  language: row.language,
  durationMs: row.durationMs,
  latencyMs: row.latencyMs,
  error: row.error,
  requestedById: row.requestedById,
  createdAt: iso(row.createdAt),
  completedAt: row.completedAt ? iso(row.completedAt) : null,
  translationStatus: row.translationStatus,
  translatedText: row.translatedText,
  translatedLanguage: row.translatedLanguage,
  translationProvider: row.translationProvider ? (row.translationProvider as AiProvider) : null,
  translationModel: row.translationModel,
  translationError: row.translationError,
  translationLatencyMs: row.translationLatencyMs,
  translationCompletedAt: row.translationCompletedAt ? iso(row.translationCompletedAt) : null,
});

const isCategoriesMap = (raw: unknown): raw is Record<string, number> => {
  if (typeof raw !== "object" || raw === null) return false;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== "number") return false;
  }
  return true;
};

export const serializeModeration = (row: PrismaModeration): ModerationPayload => ({
  id: row.id,
  messageId: row.messageId,
  transcriptionId: row.transcriptionId,
  provider: row.provider as AiProvider,
  model: row.model,
  status: row.status,
  flagged: row.flagged,
  recommendation: row.recommendation ?? null,
  maxScore: row.maxScore,
  categories: isCategoriesMap(row.categories) ? row.categories : null,
  reasonSummary: row.reasonSummary,
  latencyMs: row.latencyMs,
  error: row.error,
  requestedById: row.requestedById,
  createdAt: iso(row.createdAt),
  completedAt: row.completedAt ? iso(row.completedAt) : null,
});

export type WithAi<T> = T & {
  transcriptions?: PrismaTranscription[];
  moderations?: PrismaModeration[];
};

export const serializeMessage = (message: WithAudio<WithAi<Message>>): MessagePayload => {
  const latestTranscription = (message.transcriptions ?? [])
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const latestModeration = (message.moderations ?? [])
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    id: message.id,
    status: message.status,
    questionId: message.questionId,
    notes: message.notes,
    createdAt: iso(message.createdAt),
    receivedAt: message.receivedAt ? iso(message.receivedAt) : null,
    audio: audioRef(message.audio),
    latestTranscription: latestTranscription ? serializeTranscription(latestTranscription) : null,
    latestModeration: latestModeration ? serializeModeration(latestModeration) : null,
  };
};

export const serializeStatus = (snapshot: BoothStatusSnapshot): BoothStatusEvent => ({
  state: snapshot.state,
  updatedAt: iso(snapshot.updatedAt),
  currentQuestionId: snapshot.currentQuestionId,
  currentMessageId: snapshot.currentMessageId,
  lastError: snapshot.lastError,
  runtimeMode: snapshot.runtimeMode,
});

export const defaultStatus = (): BoothStatusEvent => ({
  state: "idle",
  updatedAt: new Date().toISOString(),
  currentQuestionId: null,
  currentMessageId: null,
  lastError: null,
  runtimeMode: null,
});

export const serializeBoothEvent = (event: PrismaBoothEvent): BoothEventRecord => ({
  id: event.id,
  eventId: event.eventId,
  boothId: event.boothId,
  bootId: event.bootId,
  type: event.type as BoothEventRecord["type"],
  occurredAt: iso(event.occurredAt),
  receivedAt: iso(event.receivedAt),
  sessionId: event.sessionId,
  recordingId: event.recordingId,
  payload: event.payload,
  version: event.version,
});

export const serializeCallSession = (session: PrismaCallSession): CallSessionPayload => ({
  id: session.id,
  boothId: session.boothId,
  bootId: session.bootId,
  startedAt: iso(session.startedAt),
  endedAt: session.endedAt ? iso(session.endedAt) : null,
  digitsDialed: session.digitsDialed,
  outcome: session.outcome as CallOutcome | null,
  recordingId: session.recordingId,
  durationMs: session.durationMs,
  version: session.version,
});
