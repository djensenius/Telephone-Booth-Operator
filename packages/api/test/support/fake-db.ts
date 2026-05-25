import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

export type FakeFile = {
  id: string;
  blobContainer: string;
  blobKey: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number | null;
  contentType: string;
  createdAt: Date;
};

export type FakeQuestion = {
  id: string;
  prompt: string;
  audioId: string;
  createdAt: Date;
  retiredAt: Date | null;
};

export type FakeMessage = {
  id: string;
  status: string;
  notes: string | null;
  questionId: string | null;
  audioId: string;
  createdAt: Date;
  receivedAt: Date | null;
  decidedAt: Date | null;
  decidedById: string | null;
};

export type FakeStatus = {
  id: number;
  state: string;
  currentQuestionId: string | null;
  currentMessageId: string | null;
  lastError: string | null;
  updatedAt: Date;
};

type FakeSession = {
  id: string;
  userId: string;
  user: {
    id: string;
    oidcSub: string;
    email: string;
    name: string;
    groups: string[];
    picture: string | null;
  };
  accessTokenExpiresAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
};

export type FakeBoothEvent = {
  id: string;
  eventId: string;
  boothId: string;
  bootId: string;
  type: string;
  occurredAt: Date;
  receivedAt: Date;
  sessionId: string | null;
  recordingId: string | null;
  payload: unknown;
};

export type FakeCallSession = {
  id: string;
  boothId: string;
  bootId: string;
  startedAt: Date;
  endedAt: Date | null;
  digitsDialed: string | null;
  outcome: string | null;
  recordingId: string | null;
  durationMs: number | null;
};

export type FakeTranscription = {
  id: string;
  messageId: string;
  provider: string;
  model: string | null;
  status: "pending" | "succeeded" | "failed";
  text: string | null;
  language: string | null;
  durationMs: number | null;
  latencyMs: number | null;
  error: string | null;
  requestedById: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type FakeModeration = {
  id: string;
  messageId: string;
  transcriptionId: string | null;
  provider: string;
  model: string | null;
  status: "pending" | "succeeded" | "failed";
  flagged: boolean | null;
  recommendation: "approve" | "review" | "reject" | null;
  maxScore: number | null;
  categories: unknown;
  reasonSummary: string | null;
  latencyMs: number | null;
  error: string | null;
  requestedById: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export const store = {
  files: new Map<string, FakeFile>(),
  questions: new Map<string, FakeQuestion>(),
  messages: new Map<string, FakeMessage>(),
  statuses: [] as FakeStatus[],
  sessions: new Map<string, FakeSession>(),
  users: new Map<string, Record<string, unknown>>(),
  boothEvents: [] as FakeBoothEvent[],
  callSessions: new Map<string, FakeCallSession>(),
  transcriptions: new Map<string, FakeTranscription>(),
  moderations: new Map<string, FakeModeration>(),
};

const cloneDate = (date: Date): Date => new Date(date.getTime());

const byCreatedDesc = <T extends { createdAt: Date; id: string }>(a: T, b: T): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

const attachAudio = <T extends { audioId: string }>(record: T): T & { audio: FakeFile } => {
  const audio = store.files.get(record.audioId);
  if (!audio) throw new Error("missing fake audio");
  return { ...record, audio };
};

const fileFromData = (data: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt">): FakeFile => ({
  id: data.id ?? randomUUID(),
  createdAt: data.createdAt ?? new Date(),
  ...data,
});

export const seedFile = (overrides: Partial<FakeFile> = {}): FakeFile => {
  const sha = overrides.sha256 ?? "a".repeat(64);
  const file = fileFromData({
    blobContainer: "booth-recordings",
    blobKey: `questions/${sha.slice(0, 2)}/${sha}.flac`,
    sha256: sha,
    sizeBytes: 1234,
    durationMs: 1000,
    contentType: "audio/flac",
    ...overrides,
  });
  store.files.set(file.id, file);
  return file;
};

export const seedSession = (): FakeSession => {
  const session: FakeSession = {
    id: randomUUID(),
    userId: "operator-1",
    user: {
      id: "operator-1",
      oidcSub: "operator-1",
      email: "operator@example.com",
      name: "Operator",
      groups: ["operators"],
      picture: null,
    },
    accessTokenExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
  store.sessions.set(session.id, session);
  return session;
};

export const seedQuestion = (overrides: Partial<FakeQuestion> = {}): FakeQuestion => {
  const question: FakeQuestion = {
    id: overrides.id ?? randomUUID(),
    prompt: overrides.prompt ?? `prompt-${randomUUID().slice(0, 6)}`,
    audioId: overrides.audioId ?? seedFile().id,
    createdAt: overrides.createdAt ?? new Date(),
    retiredAt: overrides.retiredAt ?? null,
  };
  store.questions.set(question.id, question);
  return question;
};

export const seedMessage = (overrides: Partial<FakeMessage> = {}): FakeMessage => {
  const message: FakeMessage = {
    id: overrides.id ?? randomUUID(),
    status: overrides.status ?? "pending",
    notes: overrides.notes ?? null,
    questionId: overrides.questionId ?? null,
    audioId: overrides.audioId ?? seedFile().id,
    createdAt: overrides.createdAt ?? new Date(),
    receivedAt: overrides.receivedAt ?? null,
    decidedAt: overrides.decidedAt ?? null,
    decidedById: overrides.decidedById ?? null,
  };
  store.messages.set(message.id, message);
  return message;
};

export const seedStatus = (overrides: Partial<FakeStatus> = {}): FakeStatus => {
  const status: FakeStatus = {
    id: store.statuses.length + 1,
    state: overrides.state ?? "idle",
    currentQuestionId: overrides.currentQuestionId ?? null,
    currentMessageId: overrides.currentMessageId ?? null,
    lastError: overrides.lastError ?? null,
    updatedAt: overrides.updatedAt ?? new Date(),
  };
  store.statuses.push(status);
  return status;
};

export const seedCallSession = (overrides: Partial<FakeCallSession> = {}): FakeCallSession => {
  const session: FakeCallSession = {
    id: overrides.id ?? randomUUID(),
    boothId: overrides.boothId ?? "booth-1",
    bootId: overrides.bootId ?? "boot-1",
    startedAt: overrides.startedAt ?? new Date(),
    endedAt: overrides.endedAt ?? null,
    digitsDialed: overrides.digitsDialed ?? null,
    outcome: overrides.outcome ?? null,
    recordingId: overrides.recordingId ?? null,
    durationMs: overrides.durationMs ?? null,
  };
  store.callSessions.set(session.id, session);
  return session;
};

export const resetFakeDb = (): void => {
  store.files.clear();
  store.questions.clear();
  store.messages.clear();
  store.statuses.length = 0;
  store.sessions.clear();
  store.users.clear();
  store.boothEvents.length = 0;
  store.callSessions.clear();
  store.transcriptions.clear();
  store.moderations.clear();
};

const attachAi = (
  message: FakeMessage,
  include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown },
) => {
  let base: FakeMessage | (FakeMessage & { audio: FakeFile }) = message;
  if (include?.audio) {
    base = attachAudio(message);
  }
  if (include?.transcriptions !== undefined) {
    const tConfig = include.transcriptions as
      | { orderBy?: { createdAt?: "asc" | "desc" }; take?: number }
      | true;
    let transcriptions = [...store.transcriptions.values()].filter(
      (row) => row.messageId === message.id,
    );
    const tOrder = typeof tConfig === "object" ? tConfig.orderBy?.createdAt : undefined;
    transcriptions = transcriptions.sort((a, b) =>
      tOrder === "asc"
        ? a.createdAt.getTime() - b.createdAt.getTime()
        : b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const take = typeof tConfig === "object" ? tConfig.take : undefined;
    if (typeof take === "number") transcriptions = transcriptions.slice(0, take);
    (base as Record<string, unknown>).transcriptions = transcriptions;
  }
  if (include?.moderations !== undefined) {
    const mConfig = include.moderations as
      | { orderBy?: { createdAt?: "asc" | "desc" }; take?: number }
      | true;
    let moderations = [...store.moderations.values()].filter((row) => row.messageId === message.id);
    const mOrder = typeof mConfig === "object" ? mConfig.orderBy?.createdAt : undefined;
    moderations = moderations.sort((a, b) =>
      mOrder === "asc"
        ? a.createdAt.getTime() - b.createdAt.getTime()
        : b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const take = typeof mConfig === "object" ? mConfig.take : undefined;
    if (typeof take === "number") moderations = moderations.slice(0, take);
    (base as Record<string, unknown>).moderations = moderations;
  }
  return base;
};

export const fakeDb = {
  operatorUser: {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { oidcSub: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = store.users.get(where.oidcSub);
      if (!existing) {
        const next = { ...create };
        store.users.set(where.oidcSub, next);
        return next;
      }
      const merged = { ...existing, ...update };
      store.users.set(where.oidcSub, merged);
      return merged;
    },
  },
  file: {
    findUnique: async ({
      where,
    }: {
      where: { id?: string; sha256?: string; blobKey?: string };
    }) => {
      if (where.id) return store.files.get(where.id) ?? null;
      if (where.sha256)
        return [...store.files.values()].find((file) => file.sha256 === where.sha256) ?? null;
      if (where.blobKey)
        return [...store.files.values()].find((file) => file.blobKey === where.blobKey) ?? null;
      return null;
    },
    create: async ({ data }: { data: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt"> }) => {
      const file = fileFromData(data);
      store.files.set(file.id, file);
      return file;
    },
    upsert: async ({
      where,
      create: createData,
    }: {
      where: { sha256: string };
      create: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt">;
      update: Partial<FakeFile>;
    }) => {
      const existing = [...store.files.values()].find((f) => f.sha256 === where.sha256);
      if (existing) return existing;
      const file = fileFromData(createData);
      store.files.set(file.id, file);
      return file;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeFile> }) => {
      const existing = store.files.get(where.id);
      if (!existing) throw new Error("file not found");
      const updated = { ...existing, ...data };
      store.files.set(where.id, updated);
      return updated;
    },
  },
  question: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.questions.get(where.id) ?? null,
    create: async ({
      data,
      include,
    }: {
      data: { prompt: string; audioId: string };
      include?: { audio?: boolean };
    }) => {
      const question: FakeQuestion = {
        id: randomUUID(),
        prompt: data.prompt,
        audioId: data.audioId,
        createdAt: new Date(),
        retiredAt: null,
      };
      store.questions.set(question.id, question);
      return include?.audio ? attachAudio(question) : question;
    },
    findMany: async ({
      cursor,
      skip = 0,
      take,
      include,
    }: {
      cursor?: { id: string };
      skip?: number;
      take: number;
      include?: { audio?: boolean };
    }) => {
      let questions = [...store.questions.values()]
        .filter((question) => question.retiredAt === null)
        .sort(byCreatedDesc);
      if (cursor) {
        const index = questions.findIndex((question) => question.id === cursor.id);
        questions = index >= 0 ? questions.slice(index + skip) : questions;
      }
      const selected = questions.slice(0, take);
      return include?.audio ? selected.map(attachAudio) : selected;
    },
    count: async () =>
      [...store.questions.values()].filter((question) => question.retiredAt === null).length,
    findFirst: async ({ skip = 0, include }: { skip?: number; include?: { audio?: boolean } }) => {
      const question = [...store.questions.values()]
        .filter((item) => item.retiredAt === null)
        .sort((a, b) => a.id.localeCompare(b.id))[skip];
      if (!question) return null;
      return include?.audio ? attachAudio(question) : question;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeQuestion> }) => {
      const existing = store.questions.get(where.id);
      if (!existing) throw new Error("question not found");
      const updated = { ...existing, ...data };
      store.questions.set(where.id, updated);
      return updated;
    },
  },
  message: {
    findUnique: async ({
      where,
      include,
      select,
    }: {
      where: { id?: string; audioId?: string };
      include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown };
      select?: { id?: boolean; status?: boolean };
    }) => {
      const message = where.id
        ? store.messages.get(where.id)
        : [...store.messages.values()].find((item) => item.audioId === where.audioId);
      if (!message) return null;
      if (select) {
        const out: Record<string, unknown> = {};
        if (select.id) out.id = message.id;
        if (select.status) out.status = message.status;
        return out;
      }
      if (include) return attachAi(message, include);
      return message;
    },
    findMany: async ({
      where = {},
      include,
      take,
      orderBy,
    }: {
      where?: { status?: string; createdAt?: { gte: Date } };
      include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown };
      take: number;
      orderBy?: unknown;
    }) => {
      void orderBy;
      let messages = [...store.messages.values()];
      if (where.status) messages = messages.filter((message) => message.status === where.status);
      if (where.createdAt?.gte)
        messages = messages.filter((message) => message.createdAt >= where.createdAt.gte);
      messages = messages.sort(byCreatedDesc).slice(0, take);
      if (include) return messages.map((message) => attachAi(message, include));
      return messages;
    },
    create: async ({
      data,
    }: {
      data: { status: string; questionId?: string | null; audioId: string };
    }) => {
      const duplicate = [...store.messages.values()].find((m) => m.audioId === data.audioId);
      if (duplicate) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`audioId`)", {
          code: "P2002",
          clientVersion: "5.0.0",
          meta: { target: ["audioId"] },
        });
      }
      const message: FakeMessage = {
        id: randomUUID(),
        status: data.status,
        notes: null,
        questionId: data.questionId ?? null,
        audioId: data.audioId,
        createdAt: new Date(),
        receivedAt: null,
        decidedAt: null,
        decidedById: null,
      };
      store.messages.set(message.id, message);
      return message;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeMessage> }) => {
      const existing = store.messages.get(where.id);
      if (!existing) throw new Error("message not found");
      const updated = { ...existing, ...data };
      store.messages.set(where.id, updated);
      return updated;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string };
      data: Partial<FakeMessage>;
    }) => {
      const existing = store.messages.get(where.id);
      if (!existing) return { count: 0 };
      if (where.status && existing.status !== where.status) return { count: 0 };
      const updated = { ...existing, ...data };
      store.messages.set(where.id, updated);
      return { count: 1 };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = store.messages.get(where.id);
      if (!existing) throw new Error("message not found");
      store.messages.delete(where.id);
      return existing;
    },
    findFirst: async ({
      where = {},
      include,
      orderBy,
      select,
      skip = 0,
    }: {
      where?: { status?: string };
      include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown };
      orderBy?: { createdAt?: "asc" | "desc"; id?: "asc" | "desc" };
      select?: { id?: boolean };
      skip?: number;
    } = {}) => {
      const order = orderBy?.createdAt ?? "desc";
      let messages = [...store.messages.values()];
      if (where.status) messages = messages.filter((message) => message.status === where.status);
      messages = messages.sort((a, b) => {
        if (orderBy?.id) {
          return orderBy.id === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
        }
        return order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime();
      });
      const first = messages[skip];
      if (!first) return null;
      if (select?.id) return { id: first.id };
      if (include) return attachAi(first, include);
      return first;
    },
    count: async ({
      where = {},
    }: { where?: { status?: string; createdAt?: { gte: Date } } } = {}) => {
      let messages = [...store.messages.values()];
      if (where.status) messages = messages.filter((message) => message.status === where.status);
      if (where.createdAt?.gte)
        messages = messages.filter((message) => message.createdAt >= where.createdAt.gte);
      return messages.length;
    },
  },
  transcription: {
    create: async ({
      data,
    }: {
      data: Partial<FakeTranscription> & { messageId: string; provider: string };
    }) => {
      const row: FakeTranscription = {
        id: randomUUID(),
        messageId: data.messageId,
        provider: data.provider,
        model: data.model ?? null,
        status: data.status ?? "pending",
        text: data.text ?? null,
        language: data.language ?? null,
        durationMs: data.durationMs ?? null,
        latencyMs: data.latencyMs ?? null,
        error: data.error ?? null,
        requestedById: data.requestedById ?? null,
        createdAt: data.createdAt ?? new Date(),
        completedAt: data.completedAt ?? null,
      };
      store.transcriptions.set(row.id, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<FakeTranscription>;
    }) => {
      const existing = store.transcriptions.get(where.id);
      if (!existing) throw new Error("transcription not found");
      const updated = { ...existing, ...data };
      store.transcriptions.set(where.id, updated);
      return updated;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.transcriptions.get(where.id) ?? null,
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: { messageId: string; status?: string };
      orderBy?: { createdAt?: "asc" | "desc" };
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      const rows = [...store.transcriptions.values()].filter(
        (row) =>
          row.messageId === where.messageId && (where.status ? row.status === where.status : true),
      );
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return rows[0] ?? null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where: { messageId: string };
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      let rows = [...store.transcriptions.values()].filter(
        (row) => row.messageId === where.messageId,
      );
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      if (typeof take === "number") rows = rows.slice(0, take);
      return rows;
    },
  },
  moderation: {
    create: async ({
      data,
    }: {
      data: Partial<FakeModeration> & { messageId: string; provider: string };
    }) => {
      const row: FakeModeration = {
        id: randomUUID(),
        messageId: data.messageId,
        transcriptionId: data.transcriptionId ?? null,
        provider: data.provider,
        model: data.model ?? null,
        status: data.status ?? "pending",
        flagged: data.flagged ?? null,
        recommendation: data.recommendation ?? null,
        maxScore: data.maxScore ?? null,
        categories: data.categories ?? null,
        reasonSummary: data.reasonSummary ?? null,
        latencyMs: data.latencyMs ?? null,
        error: data.error ?? null,
        requestedById: data.requestedById ?? null,
        createdAt: new Date(),
        completedAt: data.completedAt ?? null,
      };
      store.moderations.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeModeration> }) => {
      const existing = store.moderations.get(where.id);
      if (!existing) throw new Error("moderation not found");
      const updated = { ...existing, ...data };
      store.moderations.set(where.id, updated);
      return updated;
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.moderations.get(where.id) ?? null,
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: { messageId: string };
      orderBy?: { createdAt?: "asc" | "desc" };
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      const rows = [...store.moderations.values()].filter(
        (row) => row.messageId === where.messageId,
      );
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return rows[0] ?? null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where: { messageId: string };
      orderBy?: { createdAt?: "asc" | "desc" };
      take?: number;
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      let rows = [...store.moderations.values()].filter((row) => row.messageId === where.messageId);
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      if (typeof take === "number") rows = rows.slice(0, take);
      return rows;
    },
  },
  boothStatusSnapshot: {
    create: async ({ data }: { data: Omit<FakeStatus, "id"> }) => {
      const snapshot: FakeStatus = {
        id: store.statuses.length + 1,
        ...data,
        updatedAt: cloneDate(data.updatedAt),
      };
      store.statuses.push(snapshot);
      return snapshot;
    },
    findFirst: async () =>
      [...store.statuses].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null,
    findMany: async ({
      where = {},
      take,
      skip = 0,
      orderBy,
      select,
    }: {
      where?: { updatedAt?: { gte?: Date; lt?: Date }; id?: { lt?: number } };
      take?: number;
      skip?: number;
      orderBy?: { updatedAt?: "asc" | "desc" };
      select?: { id?: boolean; updatedAt?: boolean };
    }) => {
      let statuses = [...store.statuses];
      if (where.updatedAt?.gte)
        statuses = statuses.filter((status) => status.updatedAt >= where.updatedAt!.gte!);
      if (where.updatedAt?.lt)
        statuses = statuses.filter((status) => status.updatedAt < where.updatedAt!.lt!);
      if (where.id?.lt) statuses = statuses.filter((status) => status.id < where.id!.lt!);
      const dir = orderBy?.updatedAt === "asc" ? 1 : -1;
      statuses = statuses.sort((a, b) => dir * (a.updatedAt.getTime() - b.updatedAt.getTime()));
      statuses = statuses.slice(skip, take !== undefined ? skip + take : undefined);
      if (select) {
        return statuses.map((s) => {
          const out: Record<string, unknown> = {};
          if (select.id) out.id = s.id;
          if (select.updatedAt) out.updatedAt = s.updatedAt;
          return out;
        });
      }
      return statuses;
    },
    count: async () => store.statuses.length,
    deleteMany: async ({
      where = {},
    }: {
      where?: { updatedAt?: { lt?: Date }; id?: { lt?: number } };
    }) => {
      const before = store.statuses.length;
      const keep = store.statuses.filter((s) => {
        if (where.updatedAt?.lt && s.updatedAt >= where.updatedAt.lt) return true;
        if (where.id?.lt && s.id >= where.id.lt) return true;
        // Must fail BOTH conditions to be deleted
        const failsTime = where.updatedAt?.lt ? s.updatedAt < where.updatedAt.lt : true;
        const failsId = where.id?.lt ? s.id < where.id.lt : true;
        return !(failsTime && failsId);
      });
      store.statuses.length = 0;
      store.statuses.push(...keep);
      return { count: before - store.statuses.length };
    },
  },
  operatorSession: {
    findUnique: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { user?: boolean };
    }) => {
      const session = store.sessions.get(where.id);
      if (!session) return null;
      return include?.user ? session : { ...session, user: undefined };
    },
    update: async ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Partial<FakeSession>;
      include?: { user?: boolean };
    }) => {
      const existing = store.sessions.get(where.id);
      if (!existing) throw new Error("session not found");
      const updated = { ...existing, ...data };
      store.sessions.set(where.id, updated);
      return include?.user ? updated : { ...updated, user: undefined };
    },
  },
  boothEvent: {
    createMany: async ({
      data,
      skipDuplicates,
    }: {
      data: Array<Omit<FakeBoothEvent, "id" | "receivedAt">>;
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        const dup = store.boothEvents.some(
          (event) => event.boothId === row.boothId && event.eventId === row.eventId,
        );
        if (dup && skipDuplicates) continue;
        if (dup) throw new Error("duplicate event");
        store.boothEvents.push({
          id: randomUUID(),
          receivedAt: new Date(),
          ...row,
        });
        count += 1;
      }
      return { count };
    },
    findMany: async ({
      where = {},
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }) => {
      const matchesEvent = (event: FakeBoothEvent): boolean => matchesWhere(event, where);
      let events = store.boothEvents.filter(matchesEvent);
      events = sortBoothEvents(events, orderBy);
      if (typeof take === "number") events = events.slice(0, take);
      return events;
    },
  },
  callSession: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.callSessions.get(where.id) ?? null,
    findMany: async ({
      where = {},
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    }) => {
      let sessions = [...store.callSessions.values()].filter((session) =>
        matchesWhere(session, where),
      );
      sessions = sortCallSessions(sessions, orderBy);
      if (typeof take === "number") sessions = sessions.slice(0, take);
      return sessions;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: FakeCallSession;
      update: Partial<FakeCallSession>;
    }) => {
      const existing = store.callSessions.get(where.id);
      if (!existing) {
        const created: FakeCallSession = { ...create };
        store.callSessions.set(where.id, created);
        return created;
      }
      const merged: FakeCallSession = { ...existing, ...update };
      store.callSessions.set(where.id, merged);
      return merged;
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.callSessions.values()].filter((session) => matchesWhere(session, where)).length,
  },
  $transaction: async <T>(fn: (tx: typeof fakeDb) => Promise<T>): Promise<T> => fn(fakeDb),
};

const matchesWhere = (record: Record<string, unknown>, where: Record<string, unknown>): boolean => {
  for (const [key, raw] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(raw)) {
      const ok = raw.some((branch) => matchesWhere(record, branch as Record<string, unknown>));
      if (!ok) return false;
      continue;
    }
    const value = record[key];
    if (raw === null || raw === undefined) {
      if (value !== raw) return false;
      continue;
    }
    if (typeof raw === "object") {
      const filter = raw as Record<string, unknown>;
      if ("in" in filter) {
        if (!Array.isArray(filter.in) || !(filter.in as unknown[]).includes(value)) return false;
      }
      if ("gte" in filter && value !== undefined && value !== null) {
        if (compareValues(value, filter.gte) < 0) return false;
      }
      if ("lte" in filter && value !== undefined && value !== null) {
        if (compareValues(value, filter.lte) > 0) return false;
      }
      if ("lt" in filter && value !== undefined && value !== null) {
        if (compareValues(value, filter.lt) >= 0) return false;
      }
      if ("gt" in filter && value !== undefined && value !== null) {
        if (compareValues(value, filter.gt) <= 0) return false;
      }
    } else {
      if (value !== raw) return false;
    }
  }
  return true;
};

const compareValues = (a: unknown, b: unknown): number => {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Date && typeof b === "string") return a.getTime() - new Date(b).getTime();
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return 0;
};

const sortBoothEvents = (events: FakeBoothEvent[], orderBy: unknown): FakeBoothEvent[] => {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...events].sort((a, b) => {
    for (const order of orders) {
      const entries = Object.entries(order as Record<string, "asc" | "desc">);
      for (const [key, dir] of entries) {
        const av = (a as unknown as Record<string, unknown>)[key];
        const bv = (b as unknown as Record<string, unknown>)[key];
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
    }
    return 0;
  });
};

const sortCallSessions = (sessions: FakeCallSession[], orderBy: unknown): FakeCallSession[] => {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...sessions].sort((a, b) => {
    for (const order of orders) {
      const entries = Object.entries(order as Record<string, "asc" | "desc">);
      for (const [key, dir] of entries) {
        const av = (a as unknown as Record<string, unknown>)[key];
        const bv = (b as unknown as Record<string, unknown>)[key];
        const cmp = compareValues(av, bv);
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
    }
    return 0;
  });
};
