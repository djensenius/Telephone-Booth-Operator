import { randomUUID } from "node:crypto";
import { Prisma } from "../../src/generated/prisma/client.js";

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
  status: string;
  audioId: string;
  createdAt: Date;
  retiredAt: Date | null;
  installationId: string | null;
};

export type FakeInstruction = {
  id: string;
  description: string | null;
  status: string;
  audioId: string;
  createdAt: Date;
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
  reviewClassification: "likely_hangup" | "unclear" | null;
  reviewRecommendation: "delete" | "review" | null;
  reviewClassifiedAt: Date | null;
  reviewClassifiedById: string | null;
  processingLeaseTokenHash: string | null;
  processingLeaseExpiresAt: Date | null;
  processingLeasedAt: Date | null;
  processingLeasedById: string | null;
  processingSnapshotHash: string | null;
  processingAttemptCount: number;
  processingError: string | null;
  processingFailedAt: Date | null;
  processingCompletedAt: Date | null;
  installationId: string | null;
};

export type FakeStatus = {
  id: number;
  state: string;
  currentQuestionId: string | null;
  currentMessageId: string | null;
  lastError: string | null;
  runtimeMode: "real" | "mock" | "simulator" | null;
  firstSeenAt: Date;
  repeatCount: number;
  updatedAt: Date;
  installationId: string | null;
};

export type FakeSystemSnapshot = {
  boothId: string;
  snapshot: unknown;
  receivedAt: Date;
  version: string | null;
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
    isAdmin: boolean;
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
  version: string | null;
  installationId: string | null;
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
  version: string | null;
  installationId: string | null;
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
  // Pull-worker lease columns (transcription job).
  leasedAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  // Translation step columns (lives on the transcription row).
  translationStatus: "pending" | "succeeded" | "failed" | null;
  translatedText: string | null;
  translatedLanguage: string | null;
  translationProvider: string | null;
  translationModel: string | null;
  translationError: string | null;
  translationLatencyMs: number | null;
  translationCompletedAt: Date | null;
  translationLeasedAt: Date | null;
  translationLeaseToken: string | null;
  translationLeaseExpiresAt: Date | null;
  translationAttemptCount: number;
};

export type FakePushNotificationState = {
  key: string;
  active: boolean;
  threshold: number;
  updatedAt: Date;
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
  pushNotifiedAt: Date | null;
  // Pull-worker lease columns (moderation job).
  leasedAt: Date | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
};

export type FakeMobileDevice = {
  id: string;
  userId: string;
  apnsToken: string;
  platform: string;
  deviceName: string | null;
  preferences: Record<string, unknown>;
  registeredAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
};

export type FakeMetricFilter = {
  id: string;
  userId: string;
  name: string;
  window: string | null;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// A named era of the booth. The fake db always has exactly one active
// installation seeded by `resetFakeDb`, mirroring the production invariant
// enforced by the `Installation_single_active_idx` partial unique index.
export type FakeInstallation = {
  id: string;
  name: string;
  notes: string | null;
  location: string | null;
  defaultTranscriptionLanguage: string | null;
  startedAt: Date;
  endedAt: Date | null;
  endedById: string | null;
  summary: unknown;
  createdAt: Date;
};

// Stable id so tests can assert on scoping without reading it back first.
export const DEFAULT_INSTALLATION_ID = "00000000-0000-4000-8000-0000000000ff";

export type FakeAuditLog = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  actorType: string;
  actorUserId: string | null;
  actorTokenId: string | null;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  method: string;
  path: string;
  statusCode: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export const store = {
  files: new Map<string, FakeFile>(),
  questions: new Map<string, FakeQuestion>(),
  instructions: new Map<string, FakeInstruction>(),
  messages: new Map<string, FakeMessage>(),
  statuses: [] as FakeStatus[],
  systemSnapshots: new Map<string, FakeSystemSnapshot>(),
  sessions: new Map<string, FakeSession>(),
  users: new Map<string, Record<string, unknown>>(),
  boothEvents: [] as FakeBoothEvent[],
  callSessions: new Map<string, FakeCallSession>(),
  transcriptions: new Map<string, FakeTranscription>(),
  moderations: new Map<string, FakeModeration>(),
  pushNotificationStates: new Map<string, FakePushNotificationState>(),
  mobileDevices: new Map<string, FakeMobileDevice>(),
  metricFilters: new Map<string, FakeMetricFilter>(),
  installations: new Map<string, FakeInstallation>(),
  auditLogs: [] as FakeAuditLog[],
};

const cloneDate = (date: Date): Date => new Date(date.getTime());

const byCreatedDesc = <T extends { createdAt: Date; id: string }>(a: T, b: T): number =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

type StatusOrder = {
  updatedAt?: "asc" | "desc";
  firstSeenAt?: "asc" | "desc";
  id?: "asc" | "desc";
};

// Sorts by the requested fields in clause order, like Prisma. Callers that pass
// no `orderBy` get the default the routes rely on: newest row first.
const sortStatuses = <T extends { updatedAt: Date; firstSeenAt: Date; id: number }>(
  rows: T[],
  orderBy: StatusOrder | StatusOrder[] | undefined,
): T[] => {
  const requested = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const clauses: StatusOrder[] = requested.length
    ? requested
    : [{ updatedAt: "desc" }, { id: "desc" }];
  const valueOf = (row: T, field: keyof StatusOrder) =>
    field === "id" ? row.id : row[field].getTime();
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const field of Object.keys(clause) as (keyof StatusOrder)[]) {
        const direction = clause[field] === "asc" ? 1 : -1;
        const delta = direction * (valueOf(a, field) - valueOf(b, field));
        if (delta !== 0) return delta;
      }
    }
    return 0;
  });
};

type CreatedIdOrder =
  | { createdAt?: "asc" | "desc" }
  | Array<{ createdAt?: "asc" | "desc"; id?: "asc" | "desc" }>;

const sortByCreatedIdOrder = <T extends { createdAt: Date; id: string }>(
  rows: T[],
  orderBy: CreatedIdOrder | undefined,
): T[] => {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy ?? { createdAt: "desc" as const }];
  const createdAtOrder = clauses.find((clause) => clause?.createdAt)?.createdAt ?? "desc";
  const idOrder = clauses.find((clause) => clause?.id)?.id;
  const createdAtDirection = createdAtOrder === "asc" ? 1 : -1;
  const idDirection = idOrder === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const createdAtDiff = createdAtDirection * (a.createdAt.getTime() - b.createdAt.getTime());
    if (createdAtDiff !== 0) return createdAtDiff;
    return idOrder ? idDirection * a.id.localeCompare(b.id) : 0;
  });
};

// Minimal Prisma-style predicate evaluator used by jobs.ts queries. Supports
// equality, `not`, `lt`, `OR`, and the `is` relation filter we use for the
// "moderation can only be claimed when translation isn't pending" guard.
// Kept intentionally tiny — extend as new query shapes appear in tests.
type Predicate = Record<string, unknown> | undefined;

const matchScalar = (value: unknown, expected: unknown): boolean => {
  if (expected === null || expected === undefined) return value === expected;
  if (typeof expected === "object" && !(expected instanceof Date)) {
    const expObj = expected as Record<string, unknown>;
    if ("not" in expObj) {
      return value !== expObj.not;
    }
    if ("lt" in expObj) {
      if (value === null || value === undefined) return false;
      if (value instanceof Date && expObj.lt instanceof Date) {
        return value.getTime() < expObj.lt.getTime();
      }
      if (typeof value === "string" && typeof expObj.lt === "string") {
        return value.localeCompare(expObj.lt) < 0;
      }
      return (value as number) < (expObj.lt as number);
    }
    if ("lte" in expObj) {
      if (value === null || value === undefined) return false;
      if (value instanceof Date && expObj.lte instanceof Date) {
        return value.getTime() <= expObj.lte.getTime();
      }
      return (value as number) <= (expObj.lte as number);
    }
    if ("gt" in expObj) {
      if (value === null || value === undefined) return false;
      if (value instanceof Date && expObj.gt instanceof Date) {
        return value.getTime() > expObj.gt.getTime();
      }
      return (value as number) > (expObj.gt as number);
    }
    if ("in" in expObj && Array.isArray(expObj.in)) {
      return expObj.in.includes(value);
    }
    if ("increment" in expObj) {
      // Should not appear in WHERE; ignore.
      return true;
    }
  }
  if (value instanceof Date && expected instanceof Date) {
    return value.getTime() === expected.getTime();
  }
  return value === expected;
};

const matchPredicate = <T extends Record<string, unknown>>(
  row: T,
  where: Predicate,
  relations: Record<string, (key: string) => unknown> = {},
): boolean => {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(expected)) {
      const anyMatch = (expected as Predicate[]).some((p) => matchPredicate(row, p, relations));
      if (!anyMatch) return false;
      continue;
    }
    if (key === "AND" && Array.isArray(expected)) {
      const allMatch = (expected as Predicate[]).every((p) => matchPredicate(row, p, relations));
      if (!allMatch) return false;
      continue;
    }
    // Relation filter: { relationName: { is: { ... } } }
    if (
      typeof expected === "object" &&
      expected !== null &&
      "is" in (expected as Record<string, unknown>) &&
      relations[key]
    ) {
      const related = relations[key](key);
      if (related === null || related === undefined) {
        // `is: { ... }` only matches when the related row exists.
        return false;
      }
      if (!matchPredicate(related as Record<string, unknown>, (expected as { is: Predicate }).is)) {
        return false;
      }
      continue;
    }
    if (!matchScalar((row as Record<string, unknown>)[key], expected)) return false;
  }
  return true;
};

const applyUpdate = <T extends Record<string, unknown>>(
  row: T,
  data: Record<string, unknown>,
): T => {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      "increment" in (value as Record<string, unknown>)
    ) {
      const inc = (value as { increment: number }).increment;
      const current = typeof out[key] === "number" ? (out[key] as number) : 0;
      out[key] = current + inc;
      continue;
    }
    out[key] = value;
  }
  return out as T;
};

const attachAudio = <T extends { audioId: string }>(record: T): T & { audio: FakeFile } => {
  const audio = store.files.get(record.audioId);
  if (!audio) throw new Error("missing fake audio");
  return { ...record, audio };
};

// Mirrors Prisma's `select: { audio: { select: { … } } }` projection, used by
// the installation purge to resolve the blobs an era owns.
const projectAudio = (
  record: { audioId: string },
  selection?: { select?: Record<string, boolean> },
): { audio: Record<string, unknown> | null } => {
  const audio = store.files.get(record.audioId);
  if (!audio) return { audio: null };
  const fields = selection?.select;
  if (!fields) return { audio: audio as unknown as Record<string, unknown> };
  const projected: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(fields)) {
    if (wanted) projected[key] = (audio as unknown as Record<string, unknown>)[key];
  }
  return { audio: projected };
};

// The real schema enforces unique indexes that this store otherwise ignores,
// which lets a query that Postgres would reject pass in tests. Mirror the ones
// the app actually relies on.
// Scope filters arrive either as a plain id or, when no installation is open,
// as `{ in: [] }` — Prisma's way of saying "match nothing". The bespoke
// filters below have to honour both, or a test would see the whole store where
// production sees an empty list.
type ScopeFilter = string | { in: string[] };

const matchesScope = (value: string | null, filter: ScopeFilter | undefined): boolean => {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  return value !== null && filter.in.includes(value);
};

const uniqueViolation = (fields: string[]): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (\`${fields.join("`,`")}\`)`,
    { code: "P2002", clientVersion: "5.0.0", meta: { target: fields } },
  );

const assertFileUnique = (file: FakeFile): void => {
  for (const existing of store.files.values()) {
    if (existing.id === file.id) continue;
    if (existing.blobKey === file.blobKey) throw uniqueViolation(["blobKey"]);
    if (existing.sha256 === file.sha256) throw uniqueViolation(["sha256"]);
  }
};

// `Question.prompt` is unique per installation, not globally.
const assertQuestionUnique = (question: FakeQuestion): void => {
  for (const existing of store.questions.values()) {
    if (existing.id === question.id) continue;
    if (
      existing.prompt === question.prompt &&
      existing.installationId === question.installationId
    ) {
      throw uniqueViolation(["installationId", "prompt"]);
    }
  }
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

export const seedSession = (overrides?: { isAdmin?: boolean }): FakeSession => {
  const session: FakeSession = {
    id: randomUUID(),
    userId: "operator-1",
    user: {
      id: "operator-1",
      oidcSub: "operator-1",
      email: "operator@example.com",
      name: "Operator",
      groups: ["operators"],
      isAdmin: overrides?.isAdmin ?? true,
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
    status: overrides.status ?? "active",
    audioId: overrides.audioId ?? seedFile().id,
    createdAt: overrides.createdAt ?? new Date(),
    retiredAt: overrides.retiredAt ?? null,
    installationId: overrides.installationId ?? DEFAULT_INSTALLATION_ID,
  };
  store.questions.set(question.id, question);
  return question;
};

export const seedInstruction = (overrides: Partial<FakeInstruction> = {}): FakeInstruction => {
  const instruction: FakeInstruction = {
    id: overrides.id ?? randomUUID(),
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    audioId: overrides.audioId ?? seedFile().id,
    createdAt: overrides.createdAt ?? new Date(),
  };
  store.instructions.set(instruction.id, instruction);
  return instruction;
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
    reviewClassification: overrides.reviewClassification ?? null,
    reviewRecommendation: overrides.reviewRecommendation ?? null,
    reviewClassifiedAt: overrides.reviewClassifiedAt ?? null,
    reviewClassifiedById: overrides.reviewClassifiedById ?? null,
    processingLeaseTokenHash: overrides.processingLeaseTokenHash ?? null,
    processingLeaseExpiresAt: overrides.processingLeaseExpiresAt ?? null,
    processingLeasedAt: overrides.processingLeasedAt ?? null,
    processingLeasedById: overrides.processingLeasedById ?? null,
    processingSnapshotHash: overrides.processingSnapshotHash ?? null,
    processingAttemptCount: overrides.processingAttemptCount ?? 0,
    processingError: overrides.processingError ?? null,
    processingFailedAt: overrides.processingFailedAt ?? null,
    processingCompletedAt: overrides.processingCompletedAt ?? null,
    installationId: overrides.installationId ?? DEFAULT_INSTALLATION_ID,
  };
  store.messages.set(message.id, message);
  return message;
};

export const seedInstallation = (overrides: Partial<FakeInstallation> = {}): FakeInstallation => {
  const installation: FakeInstallation = {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? "Seeded installation",
    notes: overrides.notes ?? null,
    location: overrides.location ?? null,
    defaultTranscriptionLanguage: overrides.defaultTranscriptionLanguage ?? null,
    startedAt: overrides.startedAt ?? new Date(),
    endedAt: overrides.endedAt ?? null,
    endedById: overrides.endedById ?? null,
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? new Date(),
  };
  store.installations.set(installation.id, installation);
  return installation;
};

export const seedMobileDevice = (overrides: Partial<FakeMobileDevice> = {}): FakeMobileDevice => {
  const device: FakeMobileDevice = {
    id: overrides.id ?? randomUUID(),
    userId: overrides.userId ?? randomUUID(),
    apnsToken: overrides.apnsToken ?? randomUUID().replace(/-/g, ""),
    platform: overrides.platform ?? "ios",
    deviceName: overrides.deviceName ?? null,
    preferences: overrides.preferences ?? {},
    registeredAt: overrides.registeredAt ?? new Date(),
    lastSeenAt: overrides.lastSeenAt ?? new Date(),
    revokedAt: overrides.revokedAt ?? null,
  };
  store.mobileDevices.set(device.id, device);
  return device;
};

export const seedStatus = (overrides: Partial<FakeStatus> = {}): FakeStatus => {
  const status: FakeStatus = {
    id: store.statuses.length + 1,
    state: overrides.state ?? "idle",
    currentQuestionId: overrides.currentQuestionId ?? null,
    currentMessageId: overrides.currentMessageId ?? null,
    lastError: overrides.lastError ?? null,
    runtimeMode: overrides.runtimeMode ?? null,
    firstSeenAt: overrides.firstSeenAt ?? overrides.updatedAt ?? new Date(),
    repeatCount: overrides.repeatCount ?? 1,
    updatedAt: overrides.updatedAt ?? new Date(),
    installationId: overrides.installationId ?? DEFAULT_INSTALLATION_ID,
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
    version: overrides.version ?? null,
    installationId: overrides.installationId ?? DEFAULT_INSTALLATION_ID,
  };
  store.callSessions.set(session.id, session);
  return session;
};

// Push a booth event into the store. Stamps the default installation so
// installation-scoped reads see it without every caller opting in.
export const seedBoothEvent = (overrides: Partial<FakeBoothEvent> = {}): FakeBoothEvent => {
  const occurredAt = overrides.occurredAt ?? new Date();
  const event: FakeBoothEvent = {
    id: overrides.id ?? randomUUID(),
    eventId: overrides.eventId ?? randomUUID(),
    boothId: overrides.boothId ?? "booth-1",
    bootId: overrides.bootId ?? "boot-1",
    type: overrides.type ?? "state_transition",
    occurredAt,
    receivedAt: overrides.receivedAt ?? occurredAt,
    sessionId: overrides.sessionId ?? null,
    recordingId: overrides.recordingId ?? null,
    payload: overrides.payload ?? {},
    version: overrides.version ?? null,
    installationId: overrides.installationId ?? DEFAULT_INSTALLATION_ID,
  };
  store.boothEvents.push(event);
  return event;
};

export const resetFakeDb = (): void => {
  store.files.clear();
  store.questions.clear();
  store.instructions.clear();
  store.messages.clear();
  store.statuses.length = 0;
  store.systemSnapshots.clear();
  store.sessions.clear();
  store.users.clear();
  store.boothEvents.length = 0;
  store.callSessions.clear();
  store.transcriptions.clear();
  store.moderations.clear();
  store.pushNotificationStates.clear();
  store.mobileDevices.clear();
  store.metricFilters.clear();
  store.installations.clear();
  store.installations.set(DEFAULT_INSTALLATION_ID, {
    id: DEFAULT_INSTALLATION_ID,
    name: "Installation 1",
    notes: null,
    location: null,
    defaultTranscriptionLanguage: null,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endedAt: null,
    endedById: null,
    summary: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  store.auditLogs.length = 0;
};

type FakeStoreSnapshot = Record<string, Map<unknown, unknown> | unknown[]>;

const snapshotFakeStore = (): FakeStoreSnapshot =>
  Object.fromEntries(
    Object.entries(store).map(([key, value]) => [
      key,
      value instanceof Map ? new Map(value) : [...value],
    ]),
  );

const restoreFakeStore = (snapshot: FakeStoreSnapshot): void => {
  for (const [key, saved] of Object.entries(snapshot)) {
    const current = store[key as keyof typeof store] as unknown;
    if (current instanceof Map && saved instanceof Map) {
      current.clear();
      for (const [entryKey, value] of saved) current.set(entryKey, value);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(saved)) {
      current.length = 0;
      current.push(...saved);
    }
  }
};

// Supports the `transcriptions: { none: {} } | { some: {...} }` relation
// filters used by the AI recovery sweeper.
type MessageRelationFilter = {
  transcriptions?: {
    none?: Record<string, never>;
    some?: { status?: string; createdAt?: { lt?: Date } };
  };
};

const matchesTranscriptionFilter = (
  message: FakeMessage,
  clause: MessageRelationFilter,
): boolean => {
  const filter = clause.transcriptions;
  if (!filter) return false;
  const rows = [...store.transcriptions.values()].filter((row) => row.messageId === message.id);
  if (filter.none) return rows.length === 0;
  const some = filter.some;
  if (!some) return false;
  return rows.some((row) => {
    if (some.status !== undefined && row.status !== some.status) return false;
    if (some.createdAt?.lt !== undefined && !(row.createdAt < some.createdAt.lt)) return false;
    return true;
  });
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
      | {
          orderBy?:
            | { createdAt?: "asc" | "desc"; id?: "asc" | "desc" }
            | Array<{ createdAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
          take?: number;
        }
      | true;
    let transcriptions = [...store.transcriptions.values()].filter(
      (row) => row.messageId === message.id,
    );
    const tOrderBy = typeof tConfig === "object" ? tConfig.orderBy : undefined;
    transcriptions = sortByCreatedIdOrder(transcriptions, tOrderBy as CreatedIdOrder | undefined);
    const take = typeof tConfig === "object" ? tConfig.take : undefined;
    if (typeof take === "number") transcriptions = transcriptions.slice(0, take);
    (base as Record<string, unknown>).transcriptions = transcriptions;
  }
  if (include?.moderations !== undefined) {
    const mConfig = include.moderations as
      | {
          orderBy?:
            | { createdAt?: "asc" | "desc"; id?: "asc" | "desc" }
            | Array<{ createdAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
          take?: number;
        }
      | true;
    let moderations = [...store.moderations.values()].filter((row) => row.messageId === message.id);
    const mOrderBy = typeof mConfig === "object" ? mConfig.orderBy : undefined;
    moderations = sortByCreatedIdOrder(moderations, mOrderBy as CreatedIdOrder | undefined);
    const take = typeof mConfig === "object" ? mConfig.take : undefined;
    if (typeof take === "number") moderations = moderations.slice(0, take);
    (base as Record<string, unknown>).moderations = moderations;
  }
  return base;
};

export const fakeDb = {
  operatorUser: {
    findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) => {
      const ids = where?.id?.in;
      const users = [...store.users.values()];
      return ids === undefined ? users : users.filter((user) => ids.includes(user.id));
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { oidcSub?: string; id?: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      // Import upserts by id; login upserts by oidcSub.
      if (where.id) {
        const key = (create.oidcSub as string) ?? where.id;
        const merged = { ...create };
        store.users.set(key, merged);
        return merged;
      }
      const existing = store.users.get(where.oidcSub as string);
      if (!existing) {
        const next = { ...create };
        store.users.set(where.oidcSub as string, next);
        return next;
      }
      const merged = { ...existing, ...update };
      store.users.set(where.oidcSub as string, merged);
      return merged;
    },
  },
  file: {
    deleteMany: async ({ where }: { where: Predicate }) => {
      const ids = (where?.id as { in?: string[] } | undefined)?.in;
      let count = 0;
      for (const file of [...store.files.values()]) {
        const match = ids ? ids.includes(file.id) : matchesWhere(file, where ?? {});
        if (!match) continue;
        store.files.delete(file.id);
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where = {} }: { where?: Predicate; select?: unknown } = {}) =>
      [...store.files.values()].filter((file) => matchesFileWhere(file, where ?? {})),
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
    // The purge re-checks each blob key immediately before deleting the blob,
    // so a file recreated by a concurrent upload keeps its audio.
    findFirst: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.files.values()].find((file) => matchesFileWhere(file, where)) ?? null,
    create: async ({ data }: { data: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt"> }) => {
      const file = fileFromData(data);
      assertFileUnique(file);
      store.files.set(file.id, file);
      return file;
    },
    upsert: async ({
      where,
      create: createData,
    }: {
      where: { sha256?: string; id?: string };
      create: Partial<FakeFile> & Omit<FakeFile, "id" | "createdAt">;
      update: Partial<FakeFile>;
    }) => {
      // Import uses an id-keyed upsert; the app's upload path uses sha256.
      if (where.id) {
        const file = fileFromData({ ...createData, id: where.id });
        store.files.set(file.id, file);
        return file;
      }
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
    updateMany: async ({ where, data }: { where: Predicate; data: Record<string, unknown> }) => {
      let count = 0;
      for (const question of store.questions.values()) {
        if (!matchesWhere(question, where ?? {})) continue;
        store.questions.set(question.id, { ...question, ...data } as FakeQuestion);
        count += 1;
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Predicate }) => {
      let count = 0;
      for (const question of [...store.questions.values()]) {
        if (!matchesWhere(question, where ?? {})) continue;
        store.questions.delete(question.id);
        count += 1;
      }
      return { count };
    },
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.questions.get(where.id) ?? null,
    create: async ({
      data,
      include,
    }: {
      data: {
        prompt: string;
        audioId: string;
        status?: string;
        createdAt?: Date;
        installationId?: string;
      };
      include?: { audio?: boolean };
    }) => {
      const question: FakeQuestion = {
        id: randomUUID(),
        prompt: data.prompt,
        status: data.status ?? "draft",
        audioId: data.audioId,
        createdAt: data.createdAt ?? new Date(),
        retiredAt: null,
        installationId: data.installationId ?? DEFAULT_INSTALLATION_ID,
      };
      assertQuestionUnique(question);
      store.questions.set(question.id, question);
      return include?.audio ? attachAudio(question) : question;
    },
    findMany: async (
      params: {
        cursor?: { id: string };
        where?: Record<string, unknown>;
        skip?: number;
        take?: number;
        include?: { audio?: boolean };
        select?: { audio?: { select?: Record<string, boolean> } };
      } = {},
    ) => {
      const { cursor, where = {}, skip = 0, take, include, select } = params;
      let questions = [...store.questions.values()]
        .filter((question) => matchesQuestionWhere(question, where))
        .sort(byCreatedDesc);
      if (cursor) {
        const index = questions.findIndex((question) => question.id === cursor.id);
        questions = index >= 0 ? questions.slice(index + skip) : questions;
      }
      const selected = typeof take === "number" ? questions.slice(0, take) : questions;
      if (select?.audio) return selected.map((question) => projectAudio(question, select.audio));
      return include?.audio ? selected.map(attachAudio) : selected;
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.questions.values()].filter((question) => matchesWhere(question, where)).length,
    findFirst: async ({
      where = {},
      skip = 0,
      include,
    }: {
      where?: Record<string, unknown>;
      skip?: number;
      include?: { audio?: boolean };
    }) => {
      const question = [...store.questions.values()]
        .filter((item) => matchesWhere(item, where))
        .sort((a, b) => a.id.localeCompare(b.id))[skip];
      if (!question) return null;
      return include?.audio ? attachAudio(question) : question;
    },
    update: async ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Partial<FakeQuestion>;
      include?: { audio?: boolean };
    }) => {
      const existing = store.questions.get(where.id);
      if (!existing) throw new Error("question not found");
      const updated = { ...existing, ...data };
      store.questions.set(where.id, updated);
      return include?.audio ? attachAudio(updated) : updated;
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const question = { ...(create as unknown as FakeQuestion), id: where.id };
      store.questions.set(where.id, question);
      return question;
    },
  },
  instruction: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.instructions.get(where.id) ?? null,
    create: async ({
      data,
      include,
    }: {
      data: { description?: string | null; audioId: string; status?: string };
      include?: { audio?: boolean };
    }) => {
      const instruction: FakeInstruction = {
        id: randomUUID(),
        description: data.description ?? null,
        status: data.status ?? "active",
        audioId: data.audioId,
        createdAt: new Date(),
      };
      store.instructions.set(instruction.id, instruction);
      return include?.audio ? attachAudio(instruction) : instruction;
    },
    findMany: async (
      params: {
        cursor?: { id: string };
        where?: Record<string, unknown>;
        skip?: number;
        take?: number;
        include?: { audio?: boolean };
      } = {},
    ) => {
      const { cursor, where = {}, skip = 0, take, include } = params;
      let instructions = [...store.instructions.values()]
        .filter((instruction) => matchesWhere(instruction, where))
        .sort(byCreatedDesc);
      if (cursor) {
        const index = instructions.findIndex((instruction) => instruction.id === cursor.id);
        instructions = index >= 0 ? instructions.slice(index + skip) : instructions;
      }
      const selected = typeof take === "number" ? instructions.slice(0, take) : instructions;
      return include?.audio ? selected.map(attachAudio) : selected;
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.instructions.values()].filter((instruction) => matchesWhere(instruction, where))
        .length,
    findFirst: async ({
      where = {},
      skip = 0,
      include,
      orderBy,
    }: {
      where?: Record<string, unknown>;
      skip?: number;
      include?: { audio?: boolean };
      orderBy?: CreatedIdOrder;
    }) => {
      const instruction = sortByCreatedIdOrder(
        [...store.instructions.values()].filter((item) => matchesWhere(item, where)),
        orderBy,
      )[skip];
      if (!instruction) return null;
      return include?.audio ? attachAudio(instruction) : instruction;
    },
    update: async ({
      where,
      data,
      include,
    }: {
      where: { id: string };
      data: Partial<FakeInstruction>;
      include?: { audio?: boolean };
    }) => {
      const existing = store.instructions.get(where.id);
      if (!existing) throw new Error("instruction not found");
      const updated = { ...existing, ...data };
      store.instructions.set(where.id, updated);
      return include?.audio ? attachAudio(updated) : updated;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = store.instructions.get(where.id);
      if (!existing) throw new Error("instruction not found");
      store.instructions.delete(where.id);
      return existing;
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const instruction = { ...(create as unknown as FakeInstruction), id: where.id };
      store.instructions.set(where.id, instruction);
      return instruction;
    },
  },
  message: {
    deleteMany: async ({ where }: { where: Predicate }) => {
      let count = 0;
      for (const message of [...store.messages.values()]) {
        if (!matchesWhere(message, where ?? {})) continue;
        store.messages.delete(message.id);
        count += 1;
      }
      return { count };
    },
    findUnique: async ({
      where,
      include,
      select,
    }: {
      where: { id?: string; audioId?: string };
      include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown };
      select?: {
        id?: boolean;
        status?: boolean;
        installationId?: boolean;
        processingAttemptCount?: boolean;
        audio?: boolean | { select?: Record<string, boolean> };
      };
    }) => {
      const message = where.id
        ? store.messages.get(where.id)
        : [...store.messages.values()].find((item) => item.audioId === where.audioId);
      if (!message) return null;
      if (select) {
        const out: Record<string, unknown> = {};
        if (select.id) out.id = message.id;
        if (select.status) out.status = message.status;
        if (select.installationId) out.installationId = message.installationId ?? null;
        if (select.processingAttemptCount) {
          out.processingAttemptCount = message.processingAttemptCount;
        }
        if (select.audio) {
          const audio = store.files.get(message.audioId) ?? null;
          if (audio === null) {
            out.audio = null;
          } else if (select.audio === true) {
            out.audio = audio;
          } else {
            const nested = select.audio.select ?? {};
            const projected: Record<string, unknown> = {};
            for (const [key, wanted] of Object.entries(nested)) {
              if (wanted) projected[key] = (audio as unknown as Record<string, unknown>)[key];
            }
            out.audio = projected;
          }
        }
        return out;
      }
      if (include) return attachAi(message, include);
      return message;
    },
    findMany: async ({
      where = {},
      include,
      take,
      skip = 0,
      orderBy,
      select,
    }: {
      where?: {
        status?: string | { in: readonly string[] };
        createdAt?: { gte: Date };
        installationId?: ScopeFilter;
        OR?: readonly MessageRelationFilter[];
      };
      include?: { audio?: boolean; transcriptions?: unknown; moderations?: unknown };
      take?: number;
      skip?: number;
      orderBy?: unknown;
      select?: { audio?: { select?: Record<string, boolean> } };
    }) => {
      let messages = [...store.messages.values()];
      if (where.installationId !== undefined) {
        messages = messages.filter((message) =>
          matchesScope(message.installationId, where.installationId),
        );
      }
      const status = where.status;
      if (typeof status === "string") {
        messages = messages.filter((message) => message.status === status);
      } else if (status?.in) {
        messages = messages.filter((message) => status.in.includes(message.status));
      }
      if (where.createdAt?.gte)
        messages = messages.filter((message) => message.createdAt >= where.createdAt.gte);
      if (where.OR) {
        const clauses = where.OR;
        messages = messages.filter((message) =>
          clauses.some((clause) => matchesTranscriptionFilter(message, clause)),
        );
      }
      messages = sortByCreatedIdOrder(messages, orderBy as CreatedIdOrder | undefined);
      if (skip > 0) messages = messages.slice(skip);
      if (take !== undefined) messages = messages.slice(0, take);
      if (select?.audio) return messages.map((message) => projectAudio(message, select.audio));
      if (include) return messages.map((message) => attachAi(message, include));
      return messages;
    },
    create: async ({
      data,
    }: {
      data: {
        status: string;
        questionId?: string | null;
        audioId: string;
        installationId?: string;
      };
    }) => {
      const duplicate = [...store.messages.values()].find((m) => m.audioId === data.audioId);
      if (duplicate) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`audioId`)",
          {
            code: "P2002",
            clientVersion: "5.0.0",
            meta: { target: ["audioId"] },
          },
        );
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
        reviewClassification: null,
        reviewRecommendation: null,
        reviewClassifiedAt: null,
        reviewClassifiedById: null,
        processingLeaseTokenHash: null,
        processingLeaseExpiresAt: null,
        processingLeasedAt: null,
        processingLeasedById: null,
        processingSnapshotHash: null,
        processingAttemptCount: 0,
        processingError: null,
        processingFailedAt: null,
        processingCompletedAt: null,
        installationId: data.installationId ?? DEFAULT_INSTALLATION_ID,
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
    upsert: async ({
      where,
      create,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const message = { ...(create as unknown as FakeMessage), id: where.id };
      store.messages.set(where.id, message);
      return message;
    },
    updateMany: async ({
      where = {},
      data,
    }: {
      where?: Predicate;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const message of [...store.messages.values()]) {
        if (!matchesWhere(message, where ?? {})) continue;
        store.messages.set(message.id, applyUpdate(message, data));
        count += 1;
      }
      return { count };
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
    }: {
      where?: {
        status?: string | { in?: string[]; not?: string };
        createdAt?: { gte: Date };
        receivedAt?: { gte?: Date; not?: null };
        installationId?: ScopeFilter;
      };
    } = {}) => {
      let messages = [...store.messages.values()];
      if (where.installationId !== undefined) {
        messages = messages.filter((message) =>
          matchesScope(message.installationId, where.installationId),
        );
      }
      if (where.status) {
        const status = where.status;
        if (typeof status === "object" && Array.isArray(status.in)) {
          const allowed = new Set(status.in);
          messages = messages.filter((message) => allowed.has(message.status));
        } else if (typeof status === "object" && typeof status.not === "string") {
          // The frozen summary excludes in-flight uploads this way.
          messages = messages.filter((message) => message.status !== status.not);
        } else {
          messages = messages.filter((message) => message.status === status);
        }
      }
      if (where.createdAt?.gte)
        messages = messages.filter((message) => message.createdAt >= where.createdAt.gte);
      const receivedAfter = where.receivedAt?.gte;
      if (receivedAfter) {
        messages = messages.filter(
          (message) => message.receivedAt !== null && message.receivedAt >= receivedAfter,
        );
      }
      if (where.receivedAt?.not === null) {
        messages = messages.filter((message) => message.receivedAt !== null);
      }
      return messages.length;
    },
  },
  mobileDevice: {
    findMany: async ({
      where = {},
      select,
      distinct,
    }: {
      where?: { userId?: string; revokedAt?: Date | null; id?: { in?: string[] } };
      select?: Record<string, boolean>;
      distinct?: string[];
    } = {}) => {
      let devices = [...store.mobileDevices.values()].filter((device) => {
        if ("revokedAt" in where && device.revokedAt !== where.revokedAt) return false;
        if (where.userId !== undefined && device.userId !== where.userId) return false;
        // A scoped export asks for `id: { in: [] }` to withhold the table.
        if (where.id?.in !== undefined && !where.id.in.includes(device.id)) return false;
        return true;
      });
      if (distinct?.includes("userId")) {
        const seen = new Set<string>();
        devices = devices.filter((device) => {
          if (seen.has(device.userId)) return false;
          seen.add(device.userId);
          return true;
        });
      }
      if (select) {
        return devices.map((device) => {
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            projected[key] = (device as unknown as Record<string, unknown>)[key];
          }
          return projected;
        });
      }
      return devices;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeMobileDevice> }) => {
      const existing = store.mobileDevices.get(where.id);
      if (!existing) throw new Error("mobile device not found");
      const updated = { ...existing, ...data };
      store.mobileDevices.set(where.id, updated);
      return updated;
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
        leasedAt: data.leasedAt ?? null,
        leaseToken: data.leaseToken ?? null,
        leaseExpiresAt: data.leaseExpiresAt ?? null,
        attemptCount: data.attemptCount ?? 0,
        translationStatus: data.translationStatus ?? null,
        translatedText: data.translatedText ?? null,
        translatedLanguage: data.translatedLanguage ?? null,
        translationProvider: data.translationProvider ?? null,
        translationModel: data.translationModel ?? null,
        translationError: data.translationError ?? null,
        translationLatencyMs: data.translationLatencyMs ?? null,
        translationCompletedAt: data.translationCompletedAt ?? null,
        translationLeasedAt: data.translationLeasedAt ?? null,
        translationLeaseToken: data.translationLeaseToken ?? null,
        translationLeaseExpiresAt: data.translationLeaseExpiresAt ?? null,
        translationAttemptCount: data.translationAttemptCount ?? 0,
      };
      store.transcriptions.set(row.id, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<FakeTranscription> & Record<string, unknown>;
    }) => {
      const existing = store.transcriptions.get(where.id);
      if (!existing) throw new Error("transcription not found");
      const updated = applyUpdate(existing, data);
      store.transcriptions.set(where.id, updated);
      return updated;
    },
    updateMany: async ({ where, data }: { where: Predicate; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of store.transcriptions.values()) {
        if (matchPredicate(row as unknown as Record<string, unknown>, where)) {
          store.transcriptions.set(row.id, applyUpdate(row, data));
          count += 1;
        }
      }
      return { count };
    },
    findUnique: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { message?: unknown };
    }) => {
      const row = store.transcriptions.get(where.id) ?? null;
      if (!row || !include?.message) return row;
      const message = store.messages.get(row.messageId) ?? null;
      const audio = message ? (store.files.get(message.audioId) ?? null) : null;
      return { ...row, message: message ? { ...message, audio } : null } as never;
    },
    findFirst: async ({
      where,
      orderBy,
      include,
    }: {
      where?: Predicate;
      orderBy?: { createdAt?: "asc" | "desc" };
      include?: { message?: unknown };
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      const rows = [...store.transcriptions.values()].filter((row) =>
        matchPredicate(row as unknown as Record<string, unknown>, where),
      );
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const row = rows[0] ?? null;
      if (!row || !include?.message) return row;
      const message = store.messages.get(row.messageId) ?? null;
      const audio = message ? (store.files.get(message.audioId) ?? null) : null;
      return { ...row, message: message ? { ...message, audio } : null } as never;
    },
    findMany: async ({
      where,
      orderBy,
      take,
      skip,
      select,
    }: {
      where?: Predicate;
      orderBy?: CreatedIdOrder;
      take?: number;
      skip?: number;
      select?: { id?: boolean; createdAt?: boolean; messageId?: boolean };
    }) => {
      let rows = [...store.transcriptions.values()].filter((row) =>
        matchPredicate(row as unknown as Record<string, unknown>, where),
      );
      rows = sortByCreatedIdOrder(rows, orderBy);
      if (typeof skip === "number") rows = rows.slice(skip);
      if (typeof take === "number") rows = rows.slice(0, take);
      if (select) {
        return rows.map((row) => {
          const out: Partial<FakeTranscription> = {};
          if (select.id) out.id = row.id;
          if (select.createdAt) out.createdAt = row.createdAt;
          if (select.messageId) out.messageId = row.messageId;
          return out;
        });
      }
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
        createdAt: data.createdAt ?? new Date(),
        completedAt: data.completedAt ?? null,
        pushNotifiedAt: data.pushNotifiedAt ?? null,
        leasedAt: data.leasedAt ?? null,
        leaseToken: data.leaseToken ?? null,
        leaseExpiresAt: data.leaseExpiresAt ?? null,
        attemptCount: data.attemptCount ?? 0,
      };
      store.moderations.set(row.id, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<FakeModeration> & Record<string, unknown>;
    }) => {
      const existing = store.moderations.get(where.id);
      if (!existing) throw new Error("moderation not found");
      const updated = applyUpdate(existing, data);
      store.moderations.set(where.id, updated);
      return updated;
    },
    updateMany: async ({ where, data }: { where: Predicate; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of store.moderations.values()) {
        const relations = {
          transcription: (_key: string) =>
            row.transcriptionId ? (store.transcriptions.get(row.transcriptionId) ?? null) : null,
        };
        if (matchPredicate(row as unknown as Record<string, unknown>, where, relations)) {
          store.moderations.set(row.id, applyUpdate(row, data));
          count += 1;
        }
      }
      return { count };
    },
    findUnique: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { transcription?: boolean };
    }) => {
      const row = store.moderations.get(where.id) ?? null;
      if (!row || !include?.transcription) return row;
      const transcription = row.transcriptionId
        ? (store.transcriptions.get(row.transcriptionId) ?? null)
        : null;
      return { ...row, transcription } as never;
    },
    findFirst: async ({
      where,
      orderBy,
      include,
    }: {
      where?: Predicate;
      orderBy?: { createdAt?: "asc" | "desc" };
      include?: { transcription?: boolean };
    }) => {
      const order = orderBy?.createdAt ?? "desc";
      const relations = {
        transcription: (_key: string) => null as unknown,
      };
      const rows = [...store.moderations.values()].filter((row) => {
        const rel = {
          transcription: (_key: string) =>
            row.transcriptionId ? (store.transcriptions.get(row.transcriptionId) ?? null) : null,
        };
        return matchPredicate(row as unknown as Record<string, unknown>, where, rel);
      });
      rows.sort((a, b) =>
        order === "asc"
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      void relations; // kept above for clarity / docs
      const row = rows[0] ?? null;
      if (!row || !include?.transcription) return row;
      const transcription = row.transcriptionId
        ? (store.transcriptions.get(row.transcriptionId) ?? null)
        : null;
      return { ...row, transcription } as never;
    },
    findMany: async ({
      where,
      orderBy,
      take,
      skip,
      select,
    }: {
      where?: Predicate;
      orderBy?: CreatedIdOrder;
      take?: number;
      skip?: number;
      select?: {
        id?: boolean;
        createdAt?: boolean;
        messageId?: boolean;
        transcriptionId?: boolean;
      };
    }) => {
      let rows = [...store.moderations.values()].filter((row) =>
        matchPredicate(row as unknown as Record<string, unknown>, where),
      );
      rows = sortByCreatedIdOrder(rows, orderBy);
      if (typeof skip === "number") rows = rows.slice(skip);
      if (typeof take === "number") rows = rows.slice(0, take);
      if (select) {
        return rows.map((row) => {
          const out: Partial<FakeModeration> = {};
          if (select.id) out.id = row.id;
          if (select.createdAt) out.createdAt = row.createdAt;
          if (select.messageId) out.messageId = row.messageId;
          if (select.transcriptionId) out.transcriptionId = row.transcriptionId;
          return out;
        });
      }
      return rows;
    },
  },
  boothStatusSnapshot: {
    create: async ({ data }: { data: Omit<FakeStatus, "id" | "repeatCount"> }) => {
      const snapshot: FakeStatus = {
        id: store.statuses.length + 1,
        repeatCount: 1,
        ...data,
        firstSeenAt: cloneDate(data.firstSeenAt ?? data.updatedAt),
        updatedAt: cloneDate(data.updatedAt),
      };
      store.statuses.push(snapshot);
      return snapshot;
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { id: number };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      // Archive rows carry ISO strings; Prisma coerces them to Date columns.
      const row = create as FakeStatus & { firstSeenAt?: Date | string; updatedAt: Date | string };
      const snapshot: FakeStatus = {
        ...row,
        id: where.id,
        repeatCount: row.repeatCount ?? 1,
        firstSeenAt: new Date(row.firstSeenAt ?? row.updatedAt),
        updatedAt: new Date(row.updatedAt),
      };
      const index = store.statuses.findIndex((status) => status.id === where.id);
      if (index === -1) store.statuses.push(snapshot);
      else store.statuses[index] = snapshot;
      return snapshot;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: number };
      data: {
        firstSeenAt?: Date;
        updatedAt?: Date;
        repeatCount?: { increment: number };
      };
    }) => {
      const snapshot = store.statuses.find((status) => status.id === where.id);
      if (!snapshot) throw new Error(`no BoothStatusSnapshot ${where.id}`);
      if (data.firstSeenAt) snapshot.firstSeenAt = cloneDate(data.firstSeenAt);
      if (data.updatedAt) snapshot.updatedAt = cloneDate(data.updatedAt);
      if (data.repeatCount) snapshot.repeatCount += data.repeatCount.increment;
      return snapshot;
    },
    updateMany: async ({ where = {}, data }: { where?: Predicate; data: Partial<FakeStatus> }) => {
      const matches = store.statuses.filter((status) =>
        matchesWhere(status as unknown as Record<string, unknown>, where ?? {}),
      );
      for (const status of matches) {
        Object.assign(status, data);
      }
      return { count: matches.length };
    },
    findFirst: async (
      args: {
        where?: { firstSeenAt?: { lte?: Date; gt?: Date }; installationId?: ScopeFilter };
        orderBy?: StatusOrder | StatusOrder[];
      } = {},
    ) => {
      const { lte, gt } = args.where?.firstSeenAt ?? {};
      let statuses = [...store.statuses];
      if (args.where?.installationId !== undefined) {
        statuses = statuses.filter((status) =>
          matchesScope(status.installationId, args.where?.installationId),
        );
      }
      if (lte) statuses = statuses.filter((status) => status.firstSeenAt <= lte);
      if (gt) statuses = statuses.filter((status) => status.firstSeenAt > gt);
      return sortStatuses(statuses, args.orderBy)[0] ?? null;
    },
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
      orderBy?: StatusOrder | StatusOrder[];
      select?: { id?: boolean; updatedAt?: boolean };
    }) => {
      let statuses = [...store.statuses];
      if (where.updatedAt?.gte)
        statuses = statuses.filter((status) => status.updatedAt >= where.updatedAt!.gte!);
      if (where.updatedAt?.lt)
        statuses = statuses.filter((status) => status.updatedAt < where.updatedAt!.lt!);
      if (where.id?.lt) statuses = statuses.filter((status) => status.id < where.id!.lt!);
      statuses = sortStatuses(statuses, orderBy);
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
      where?: { updatedAt?: { lt?: Date }; id?: { lt?: number }; installationId?: string };
    }) => {
      // Installation purge deletes by scope; the snapshot pruner deletes by
      // age/id using the bespoke rule below.
      if (where.installationId !== undefined) {
        const kept = store.statuses.filter((s) => s.installationId !== where.installationId);
        const removed = store.statuses.length - kept.length;
        store.statuses.length = 0;
        store.statuses.push(...kept);
        return { count: removed };
      }
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
  boothSystemSnapshot: {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { boothId: string };
      create: FakeSystemSnapshot;
      update: Omit<FakeSystemSnapshot, "boothId">;
    }) => {
      const existing = store.systemSnapshots.get(where.boothId);
      const row: FakeSystemSnapshot = existing
        ? { ...existing, ...update, receivedAt: cloneDate(update.receivedAt) }
        : { ...create, receivedAt: cloneDate(create.receivedAt) };
      store.systemSnapshots.set(where.boothId, row);
      return row;
    },
    findUnique: async ({ where }: { where: { boothId: string } }) => {
      const row = store.systemSnapshots.get(where.boothId);
      return row ? { ...row, receivedAt: cloneDate(row.receivedAt) } : null;
    },
    findMany: async () =>
      [...store.systemSnapshots.values()]
        .sort((a, b) => a.boothId.localeCompare(b.boothId))
        .map((row) => ({ ...row, receivedAt: cloneDate(row.receivedAt) })),
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
    count: async ({ where }: { where?: Predicate } = {}) =>
      store.boothEvents.filter((event) => matchesWhere(event, where ?? {})).length,
    deleteMany: async ({ where }: { where: Predicate }) => {
      const keep = store.boothEvents.filter((event) => !matchesWhere(event, where ?? {}));
      const count = store.boothEvents.length - keep.length;
      store.boothEvents.length = 0;
      store.boothEvents.push(...keep);
      return { count };
    },
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
          ...reviveDates(row),
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
    findFirst: async ({
      where = {},
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
    } = {}) => {
      const events = sortBoothEvents(
        store.boothEvents.filter((event) => matchesWhere(event, where)),
        orderBy,
      );
      return events[0] ?? null;
    },
    updateMany: async ({
      where = {},
      data,
    }: {
      where?: Record<string, unknown>;
      data: Partial<FakeBoothEvent>;
    }) => {
      const matches = store.boothEvents.filter((event) => matchesWhere(event, where));
      for (const event of matches) {
        Object.assign(event, data);
      }
      return { count: matches.length };
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: FakeBoothEvent;
      update: Partial<FakeBoothEvent>;
    }) => {
      const index = store.boothEvents.findIndex((event) => event.id === where.id);
      if (index === -1) {
        const created: FakeBoothEvent = { ...reviveDates(create), id: where.id };
        store.boothEvents.push(created);
        return created;
      }
      const merged: FakeBoothEvent = { ...store.boothEvents[index]!, ...reviveDates(update) };
      store.boothEvents[index] = merged;
      return merged;
    },
  },
  callSession: {
    deleteMany: async ({ where }: { where: Predicate }) => {
      let count = 0;
      for (const session of [...store.callSessions.values()]) {
        if (!matchesWhere(session, where ?? {})) continue;
        store.callSessions.delete(session.id);
        count += 1;
      }
      return { count };
    },
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
        const created: FakeCallSession = { ...reviveDates(create) };
        store.callSessions.set(where.id, created);
        return created;
      }
      const merged: FakeCallSession = { ...existing, ...update };
      store.callSessions.set(where.id, merged);
      return merged;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeCallSession> }) => {
      const existing = store.callSessions.get(where.id);
      if (!existing) throw new Error(`callSession ${where.id} not found`);
      const merged: FakeCallSession = { ...existing, ...data };
      store.callSessions.set(where.id, merged);
      return merged;
    },
    updateMany: async ({
      where = {},
      data,
    }: {
      where?: Record<string, unknown>;
      data: Partial<FakeCallSession>;
    }) => {
      const matches = [...store.callSessions.values()].filter((session) =>
        matchesWhere(session, where),
      );
      for (const session of matches) {
        store.callSessions.set(session.id, { ...session, ...data });
      }
      return { count: matches.length };
    },
    create: async ({ data }: { data: FakeCallSession }) => {
      const created: FakeCallSession = { ...data };
      store.callSessions.set(created.id, created);
      return created;
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.callSessions.values()].filter((session) => matchesWhere(session, where)).length,
  },
  metricFilter: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.metricFilters.get(where.id) ?? null,
    findMany: async ({ where = {} }: { where?: { userId?: string } } = {}) =>
      [...store.metricFilters.values()]
        .filter((filter) => (where.userId ? filter.userId === where.userId : true))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    create: async ({
      data,
    }: {
      data: Omit<FakeMetricFilter, "id" | "createdAt" | "updatedAt">;
    }) => {
      const now = new Date();
      const filter: FakeMetricFilter = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      store.metricFilters.set(filter.id, filter);
      return filter;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeMetricFilter> }) => {
      const existing = store.metricFilters.get(where.id);
      if (!existing) throw new Error("MetricFilter not found");
      const merged: FakeMetricFilter = { ...existing, ...data, updatedAt: new Date() };
      store.metricFilters.set(where.id, merged);
      return merged;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = store.metricFilters.get(where.id);
      store.metricFilters.delete(where.id);
      return existing ?? null;
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const filter = { ...(create as unknown as FakeMetricFilter), id: where.id };
      store.metricFilters.set(where.id, filter);
      return filter;
    },
  },
  installation: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.installations.get(where.id) ?? null,
    findFirst: async ({
      where = {},
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
    } = {}) => {
      const rows = [...store.installations.values()].filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, where),
      );
      const sorted = sortCallSessions(
        rows as unknown as FakeCallSession[],
        orderBy,
      ) as unknown as FakeInstallation[];
      return sorted[0] ?? null;
    },
    findMany: async ({
      where = {},
      orderBy,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
    } = {}) => {
      const rows = [...store.installations.values()].filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, where),
      );
      return sortCallSessions(
        rows as unknown as FakeCallSession[],
        orderBy,
      ) as unknown as FakeInstallation[];
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      [...store.installations.values()].filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, where),
      ).length,
    create: async ({ data }: { data: Partial<FakeInstallation> & { name: string } }) => {
      // Mirrors the partial unique index: a second active installation is a
      // constraint violation, not a silently-accepted second era.
      const hasActive = [...store.installations.values()].some((row) => row.endedAt === null);
      if (hasActive && (data.endedAt ?? null) === null) {
        throw new Error("Unique constraint failed on Installation_single_active_idx");
      }
      const now = new Date();
      const row: FakeInstallation = {
        id: data.id ?? randomUUID(),
        name: data.name,
        notes: data.notes ?? null,
        location: data.location ?? null,
        defaultTranscriptionLanguage: data.defaultTranscriptionLanguage ?? null,
        startedAt: data.startedAt ?? now,
        endedAt: data.endedAt ?? null,
        endedById: data.endedById ?? null,
        summary: data.summary ?? null,
        createdAt: data.createdAt ?? now,
      };
      store.installations.set(row.id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeInstallation> }) => {
      const existing = store.installations.get(where.id);
      if (!existing) throw new Error("Installation not found");
      const merged: FakeInstallation = { ...existing, ...data };
      store.installations.set(where.id, merged);
      return merged;
    },
    // The end route claims the era with a conditional update, so this has to
    // honour `endedAt: null` rather than blindly matching on id.
    updateMany: async ({
      where = {},
      data,
    }: {
      where?: Record<string, unknown>;
      data: Partial<FakeInstallation>;
    }) => {
      const matches = [...store.installations.values()].filter((row) => matchesWhere(row, where));
      for (const row of matches) store.installations.set(row.id, { ...row, ...data });
      return { count: matches.length };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const existing = store.installations.get(where.id);
      store.installations.delete(where.id);
      return existing ?? null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      // A restore passes `update: {}` for an era it only carries as a partial
      // parent, which must leave the existing row alone. A fake that always
      // applied `create` would report that as working when it does not.
      const existing = store.installations.get(where.id);
      const row = existing
        ? ({ ...existing, ...reviveDates(update), id: where.id } as FakeInstallation)
        : ({ ...reviveDates(create), id: where.id } as unknown as FakeInstallation);
      store.installations.set(where.id, row);
      return row;
    },
  },
  auditLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: FakeAuditLog = {
        id: randomUUID(),
        createdAt: new Date(),
        targetType: null,
        targetId: null,
        actorUserId: null,
        actorTokenId: null,
        ip: null,
        userAgent: null,
        metadata: null,
        ...(data as unknown as FakeAuditLog),
      };
      store.auditLogs.push(row);
      return row;
    },
    findMany: async ({
      where = {},
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: unknown;
      take?: number;
    } = {}) => {
      // The route always sorts newest-first by (createdAt, id).
      const rows = store.auditLogs
        .filter((row) => matchesWhere(row as unknown as Record<string, unknown>, where))
        .sort(byCreatedDesc);
      return take === undefined ? rows : rows.slice(0, take);
    },
    count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
      store.auditLogs.filter((row) =>
        matchesWhere(row as unknown as Record<string, unknown>, where),
      ).length,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const index = store.auditLogs.findIndex((entry) => entry.id === where.id);
      if (index >= 0) {
        const existing = store.auditLogs[index] as unknown as Record<string, unknown>;
        const merged = { ...existing, ...update, id: where.id } as unknown as FakeAuditLog;
        store.auditLogs[index] = merged;
        return merged;
      }
      const row = { ...(create as unknown as FakeAuditLog), id: where.id };
      store.auditLogs.push(row);
      return row;
    },
    deleteMany: async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      const kept = store.auditLogs.filter(
        (row) => !matchesWhere(row as unknown as Record<string, unknown>, where),
      );
      const removed = store.auditLogs.length - kept.length;
      store.auditLogs.length = 0;
      store.auditLogs.push(...kept);
      return { count: removed };
    },
  },
  pushNotificationState: {
    upsert: async ({
      where,
      create,
    }: {
      where: { key: string };
      create: { key: string; active: boolean; threshold: number };
      update: Record<string, never>;
    }) => {
      const existing = store.pushNotificationStates.get(where.key);
      if (existing) return existing;
      const row: FakePushNotificationState = {
        ...create,
        updatedAt: new Date(),
      };
      store.pushNotificationStates.set(row.key, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { key: string };
      data: { active: boolean; threshold: number };
    }) => {
      const existing = store.pushNotificationStates.get(where.key);
      if (!existing) throw new Error("push notification state not found");
      const updated = { ...existing, ...data, updatedAt: new Date() };
      store.pushNotificationStates.set(where.key, updated);
      return updated;
    },
  },
  apiToken: {
    findMany: async () => [] as Record<string, unknown>[],
    upsert: async ({
      create,
    }: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => create,
  },
  $transaction: async <T>(
    fn: (tx: typeof fakeDb) => Promise<T>,
    _options?: { isolationLevel?: string; maxWait?: number; timeout?: number },
  ): Promise<T> => {
    const snapshot = snapshotFakeStore();
    try {
      return await fn(fakeDb);
    } catch (error) {
      restoreFakeStore(snapshot);
      throw error;
    }
  },
  // The era row is locked with raw SQL — `FOR SHARE` for a writer, `FOR UPDATE`
  // for the close-out — because Prisma has no first-class row lock. There is no
  // concurrency to serialise in a test, so the fake only has to answer the
  // question the lock asks: is this era still open?
  $queryRaw: async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Array<{ endedAt: Date | null } | { id: string }>> => {
    const id = values.find((value) => typeof value === "string");
    if (strings.join("").includes('FROM "Message"')) {
      const message = typeof id === "string" ? store.messages.get(id) : undefined;
      if (strings.join("").includes('"processingLeaseTokenHash"')) {
        const [messageId, tokenHash, expiresAt, userId] = values;
        const leaseMatches =
          typeof messageId === "string" &&
          typeof tokenHash === "string" &&
          expiresAt instanceof Date &&
          typeof userId === "string" &&
          message?.processingLeaseTokenHash === tokenHash &&
          message.processingLeaseExpiresAt !== null &&
          message.processingLeaseExpiresAt > expiresAt &&
          message.processingLeasedById === userId;
        return leaseMatches && message ? [{ id: message.id }] : [];
      }
      return message ? [{ id: message.id }] : [];
    }
    const era = typeof id === "string" ? store.installations.get(id) : undefined;
    return era ? [{ endedAt: era.endedAt }] : [];
  },
};

// A scoped export filters files through their owning rows. Those are relation
// filters, which the generic matcher does not understand, so resolve them
// against the store here — otherwise a scoped export looks correct in tests
// while Prisma rejects the query outright.
// A scoped export pulls in questions a straggler message points at, which is a
// to-many relation filter the generic matcher does not understand. Resolving it
// here keeps the fake honest: Prisma would accept the query, and a fake that
// silently ignored the branch would hide whether the export is self-consistent.
const questionHasMessageIn = (question: FakeQuestion, filter: unknown): boolean => {
  const some = ((filter ?? {}) as { some?: { installationId?: string } }).some ?? {};
  return [...store.messages.values()].some(
    (message) =>
      message.questionId === question.id &&
      (some.installationId === undefined || message.installationId === some.installationId),
  );
};

const matchesQuestionWhere = (question: FakeQuestion, where: Record<string, unknown>): boolean => {
  const scalar: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(raw)) {
      const ok = raw.some((branch) =>
        matchesQuestionWhere(question, branch as Record<string, unknown>),
      );
      if (!ok) return false;
      continue;
    }
    if (key === "messages") {
      if (!questionHasMessageIn(question, raw)) return false;
      continue;
    }
    scalar[key] = raw;
  }
  return matchesWhere(question, scalar);
};

const matchesFileRelation = (file: FakeFile, key: string, filter: unknown): boolean => {
  const cond = (filter ?? {}) as Record<string, unknown>;
  if (key === "questions") {
    const some = (cond.some ?? {}) as { installationId?: string; messages?: unknown };
    return [...store.questions.values()].some((question) => {
      if (question.audioId !== file.id) return false;
      if (some.messages !== undefined) return questionHasMessageIn(question, some.messages);
      return some.installationId === undefined || question.installationId === some.installationId;
    });
  }
  if (key === "message") {
    const where = cond as { installationId?: string; isNot?: unknown };
    if ("isNot" in cond) return [...store.messages.values()].some((m) => m.audioId === file.id);
    return [...store.messages.values()].some(
      (message) =>
        message.audioId === file.id &&
        (where.installationId === undefined || message.installationId === where.installationId),
    );
  }
  if (key === "instruction") {
    return [...store.instructions.values()].some((row) => row.audioId === file.id);
  }
  return false;
};

const FILE_RELATIONS = new Set(["questions", "message", "instruction"]);

const matchesFileWhere = (file: FakeFile, where: Record<string, unknown>): boolean => {
  const scalar: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(raw)) {
      const ok = raw.some((branch) => matchesFileWhere(file, branch as Record<string, unknown>));
      if (!ok) return false;
      continue;
    }
    if (FILE_RELATIONS.has(key)) {
      if (!matchesFileRelation(file, key, raw)) return false;
      continue;
    }
    scalar[key] = raw;
  }
  return matchesWhere(file, scalar);
};

// Prisma coerces the ISO strings a restored archive carries into `Date`s. The
// fake stores whatever it is handed, so it has to do the same or the restore
// path hands `string`s to code that calls `toISOString()`.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const reviveDates = <T>(row: T): T => {
  if (row === null || typeof row !== "object") return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && ISO_DATE.test(value)) out[key] = new Date(value);
  }
  return out as T;
};

const matchesWhere = (record: Record<string, unknown>, where: Record<string, unknown>): boolean => {
  for (const [key, raw] of Object.entries(where)) {
    if (key === "OR" && Array.isArray(raw)) {
      const ok = raw.some((branch) => matchesWhere(record, branch as Record<string, unknown>));
      if (!ok) return false;
      continue;
    }
    // `AND: [ … ]` — every branch must match. Without this the generic
    // fall-through below answers "true", which quietly disables whichever
    // predicate the caller put there.
    if (key === "AND" && Array.isArray(raw)) {
      const ok = raw.every((branch) => matchesWhere(record, branch as Record<string, unknown>));
      if (!ok) return false;
      continue;
    }
    // Top-level `NOT`, as used by the conditional call-session update that
    // refuses to overwrite a rollover's outcome.
    if (key === "NOT" && raw !== null && typeof raw === "object") {
      if (matchesWhere(record, raw as Record<string, unknown>)) return false;
      continue;
    }
    // `installation: { is: { … } }` — the era a row belongs to, resolved
    // through `installationId`. The conditional session update depends on
    // this, so the fake has to model it rather than ignore it.
    // `questions: { some: { … } }` on an installation — the scoped export uses
    // it to carry a question a straggler message still points at. Without this
    // the generic matcher falls through and answers "true" for every row.
    if (key === "questions" && raw !== null && typeof raw === "object" && "some" in raw) {
      const some = (raw as { some: Record<string, unknown> }).some;
      const id = record.id;
      const ok = [...store.questions.values()].some(
        (question) =>
          question.installationId === id &&
          matchesQuestionWhere(question, some as Record<string, unknown>),
      );
      if (!ok) return false;
      continue;
    }
    if (key === "installation" && raw !== null && typeof raw === "object" && "is" in raw) {
      const id = record.installationId;
      const era = typeof id === "string" ? store.installations.get(id) : undefined;
      if (!era) return false;
      const inner = (raw as { is: Record<string, unknown> }).is;
      if (!matchesWhere(era as unknown as Record<string, unknown>, inner)) return false;
      continue;
    }
    const value = record[key];
    if (raw === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (raw === undefined) {
      if (value !== undefined) return false;
      continue;
    }
    // A Date is an object, so without this it fell into the operator branch
    // below, matched none of the operator keys, and answered "true" for every
    // row — silently deleting the equality half of a cursor's tie-break.
    if (raw instanceof Date) {
      const stamp =
        value instanceof Date
          ? value.getTime()
          : typeof value === "string"
            ? Date.parse(value)
            : NaN;
      if (stamp !== raw.getTime()) return false;
      continue;
    }
    if (typeof raw === "object") {
      const filter = raw as Record<string, unknown>;
      if ("in" in filter) {
        if (!Array.isArray(filter.in) || !(filter.in as unknown[]).includes(value)) return false;
      }
      if ("not" in filter) {
        if (filter.not === null) {
          if (value === null || value === undefined) return false;
        } else if (value === filter.not) {
          return false;
        }
      }
      if ("gte" in filter) {
        if (value === undefined || value === null) return false;
        if (compareValues(value, filter.gte) < 0) return false;
      }
      if ("lte" in filter) {
        if (value === undefined || value === null) return false;
        if (compareValues(value, filter.lte) > 0) return false;
      }
      if ("lt" in filter) {
        if (value === undefined || value === null) return false;
        if (compareValues(value, filter.lt) >= 0) return false;
      }
      if ("gt" in filter) {
        if (value === undefined || value === null) return false;
        if (compareValues(value, filter.gt) <= 0) return false;
      }
      if ("startsWith" in filter) {
        if (typeof value !== "string" || !value.startsWith(String(filter.startsWith))) return false;
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
