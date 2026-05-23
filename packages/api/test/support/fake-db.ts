import { randomUUID } from "node:crypto";

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
  user: { id: string; oidcSub: string; email: string; name: string; groups: string[]; picture: string | null };
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
};

export const store = {
  files: new Map<string, FakeFile>(),
  questions: new Map<string, FakeQuestion>(),
  messages: new Map<string, FakeMessage>(),
  statuses: [] as FakeStatus[],
  sessions: new Map<string, FakeSession>(),
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
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
  store.sessions.set(session.id, session);
  return session;
};

export const resetFakeDb = (): void => {
  store.files.clear();
  store.questions.clear();
  store.messages.clear();
  store.statuses.length = 0;
  store.sessions.clear();
};

export const fakeDb = {
  file: {
    findUnique: async ({ where }: { where: { id?: string; sha256?: string; blobKey?: string } }) => {
      if (where.id) return store.files.get(where.id) ?? null;
      if (where.sha256) return [...store.files.values()].find((file) => file.sha256 === where.sha256) ?? null;
      if (where.blobKey) return [...store.files.values()].find((file) => file.blobKey === where.blobKey) ?? null;
      return null;
    },
    create: async ({ data }: { data: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt"> }) => {
      const file = fileFromData(data);
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
    findUnique: async ({ where }: { where: { id: string } }) => store.questions.get(where.id) ?? null,
    create: async ({ data, include }: { data: { prompt: string; audioId: string }; include?: { audio?: boolean } }) => {
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
    findMany: async ({ cursor, skip = 0, take, include }: { cursor?: { id: string }; skip?: number; take: number; include?: { audio?: boolean } }) => {
      let questions = [...store.questions.values()].filter((question) => question.retiredAt === null).sort(byCreatedDesc);
      if (cursor) {
        const index = questions.findIndex((question) => question.id === cursor.id);
        questions = index >= 0 ? questions.slice(index + skip) : questions;
      }
      const selected = questions.slice(0, take);
      return include?.audio ? selected.map(attachAudio) : selected;
    },
    count: async () => [...store.questions.values()].filter((question) => question.retiredAt === null).length,
    findFirst: async ({ skip = 0, include }: { skip?: number; include?: { audio?: boolean } }) => {
      const question = [...store.questions.values()].filter((item) => item.retiredAt === null).sort((a, b) => a.id.localeCompare(b.id))[skip];
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
    findUnique: async ({ where, include }: { where: { id?: string; audioId?: string }; include?: { audio?: boolean } }) => {
      const message = where.id
        ? store.messages.get(where.id)
        : [...store.messages.values()].find((item) => item.audioId === where.audioId);
      if (!message) return null;
      return include?.audio ? attachAudio(message) : message;
    },
    findMany: async ({ where = {}, include, take }: { where?: { status?: string; createdAt?: { gte: Date } }; include?: { audio?: boolean }; take: number }) => {
      let messages = [...store.messages.values()];
      if (where.status) messages = messages.filter((message) => message.status === where.status);
      if (where.createdAt?.gte) messages = messages.filter((message) => message.createdAt >= where.createdAt.gte);
      messages = messages.sort(byCreatedDesc).slice(0, take);
      return include?.audio ? messages.map(attachAudio) : messages;
    },
    create: async ({ data }: { data: { status: string; questionId?: string | null; audioId: string } }) => {
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
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = store.messages.get(where.id);
      if (!existing) throw new Error("message not found");
      store.messages.delete(where.id);
      return existing;
    },
  },
  boothStatusSnapshot: {
    create: async ({ data }: { data: Omit<FakeStatus, "id"> }) => {
      const snapshot: FakeStatus = { id: store.statuses.length + 1, ...data, updatedAt: cloneDate(data.updatedAt) };
      store.statuses.push(snapshot);
      return snapshot;
    },
    findFirst: async () => [...store.statuses].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null,
    findMany: async ({ where = {}, take }: { where?: { updatedAt?: { gte: Date } }; take: number }) => {
      let statuses = [...store.statuses];
      if (where.updatedAt?.gte) statuses = statuses.filter((status) => status.updatedAt >= where.updatedAt.gte);
      return statuses.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, take);
    },
  },
  operatorSession: {
    findUnique: async ({ where, include }: { where: { id: string }; include?: { user?: boolean } }) => {
      const session = store.sessions.get(where.id);
      if (!session) return null;
      return include?.user ? session : { ...session, user: undefined };
    },
    update: async ({ where, data, include }: { where: { id: string }; data: Partial<FakeSession>; include?: { user?: boolean } }) => {
      const existing = store.sessions.get(where.id);
      if (!existing) throw new Error("session not found");
      const updated = { ...existing, ...data };
      store.sessions.set(where.id, updated);
      return include?.user ? updated : { ...updated, user: undefined };
    },
  },
};
