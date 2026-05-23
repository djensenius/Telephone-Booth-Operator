import type { BoothStatusSnapshot, File, Message, Question } from "@prisma/client";
import type { Message as MessagePayload, Question as QuestionPayload } from "@telephone-booth-operator/shared";
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
