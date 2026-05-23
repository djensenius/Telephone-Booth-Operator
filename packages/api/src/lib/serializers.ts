import type { BoothEvent as PrismaBoothEvent, BoothStatusSnapshot, CallSession as PrismaCallSession, File, Message, Question } from "@prisma/client";
import type {
  BoothEventRecord,
  CallOutcome,
  CallSession as CallSessionPayload,
  Message as MessagePayload,
  Question as QuestionPayload,
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

export const serializeMessage = (message: WithAudio<Message>): MessagePayload => ({
  id: message.id,
  status: message.status,
  questionId: message.questionId,
  notes: message.notes,
  createdAt: iso(message.createdAt),
  receivedAt: message.receivedAt ? iso(message.receivedAt) : null,
  audio: audioRef(message.audio),
});

export const serializeStatus = (snapshot: BoothStatusSnapshot): BoothStatusEvent => ({
  state: snapshot.state,
  updatedAt: iso(snapshot.updatedAt),
  currentQuestionId: snapshot.currentQuestionId,
  currentMessageId: snapshot.currentMessageId,
  lastError: snapshot.lastError,
});

export const defaultStatus = (): BoothStatusEvent => ({
  state: "idle",
  updatedAt: new Date().toISOString(),
  currentQuestionId: null,
  currentMessageId: null,
  lastError: null,
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
});
