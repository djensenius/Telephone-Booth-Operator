import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { z } from "zod";
import {
  ApiTokenCreatedSchema,
  AuditLogPageSchema,
  ApiTokenSchema,
  ApiTokenUsageBucketSchema,
  BoothEventListSchema,
  BoothStatusSchema,
  BoothSystemSnapshotEnvelopeSchema,
  CallSessionDetailSchema,
  CallSessionListSchema,
  CreateApiTokenRequestSchema,
  InstallationCreateSchema,
  InstallationEndSchema,
  InstallationPurgeResultSchema,
  InstallationPurgeSchema,
  InstallationSchema,
  InstallationUpdateSchema,
  InstructionCreateSchema,
  InstructionSchema,
  InstructionStatusSchema,
  MessageSchema,
  MessageDecisionSchema,
  MessageProcessingClaimRequestSchema,
  MessageProcessingClaimResponseSchema,
  MessageProcessingCompleteSchema,
  MessageProcessingFailSchema,
  MessageProcessingHeartbeatSchema,
  MessageProcessingLeaseTokenSchema,
  MessageProcessingSummarySchema,
  MessageStatusSchema,
  MetricFilterCreateSchema,
  MetricFilterSchema,
  ModerationSchema,
  OperatorMeSchema,
  QuestionCreateSchema,
  QuestionSchema,
  QuestionStatusSchema,
  StatsOverviewSchema,
  TranscriptionListSchema,
  TranscriptionSchema,
  UploadSasRequestSchema,
  UploadSlotSchema,
} from "@telephone-booth-operator/shared";
import type {
  ApiToken,
  ApiTokenCreated,
  AuditLogPage,
  ApiTokenUsageBucket,
  BoothEventList,
  BoothEventType,
  BoothStatus,
  BoothSystemSnapshotEnvelope,
  CallSessionDetail,
  CallSessionList,
  CreateApiTokenRequest,
  Installation,
  InstallationCreate,
  InstallationEnd,
  InstallationPurgeResult,
  InstallationScope,
  InstallationUpdate,
  Instruction,
  InstructionCreate,
  InstructionStatus,
  Message,
  MessageDecision,
  MessageProcessingClaimRequest,
  MessageProcessingClaimResponse,
  MessageProcessingComplete,
  MessageProcessingFail,
  MessageProcessingHeartbeat,
  MessageProcessingSummary,
  MessageStatus,
  MetricFilter,
  MetricFilterCreate,
  Moderation,
  OperatorMe,
  Question,
  QuestionCreate,
  QuestionStatus,
  StatsOverview,
  StatsWindow,
  Transcription,
  TranscriptionList,
  UploadSasRequest,
  UploadSlot,
} from "@telephone-booth-operator/shared";
import { STATUS_HISTORY_LIMIT } from "./status-history.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions<T> extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
  readonly schema?: z.ZodType<T>;
}

const StatusHistorySchema = z.object({ items: z.array(BoothStatusSchema) });
const QuestionListSchema = z.object({
  items: z.array(QuestionSchema),
  nextCursor: z.guid().nullable(),
});
const InstructionListSchema = z.object({
  items: z.array(InstructionSchema),
  nextCursor: z.guid().nullable(),
});
const MessageListSchema = z.object({ items: z.array(MessageSchema) });
const InstallationListSchema = z.object({ items: z.array(InstallationSchema) });
// The `/v1/stats/summary` response is an API-internal shape (not exported from
// `shared`), so we parse the small subset the UI actually reads. Unknown keys
// (booth snapshot, realtime) are dropped by Zod's default strip behaviour.
const StatsSummarySchema = z.object({
  messages: z.object({
    pending: z.number().int().nonnegative(),
    awaitingModeration: z.number().int().nonnegative(),
    receivedToday: z.number().int().nonnegative(),
    latestId: z.string().nullable(),
  }),
  calls: z.object({
    today: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
  }),
  generatedAt: z.string(),
});
const ApiTokenListSchema = z.array(ApiTokenSchema);
const ApiTokenUsageListSchema = z.array(ApiTokenUsageBucketSchema);

export type StatusHistory = z.infer<typeof StatusHistorySchema>;
export type QuestionList = z.infer<typeof QuestionListSchema>;
export type InstructionList = z.infer<typeof InstructionListSchema>;
export type MessageList = z.infer<typeof MessageListSchema>;
export type InstallationList = z.infer<typeof InstallationListSchema>;
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

const rawApiBaseUrl =
  typeof import.meta.env.VITE_API_BASE_URL === "string" ? import.meta.env.VITE_API_BASE_URL : "";
const API_BASE_URL = rawApiBaseUrl.replace(/\/+$/, "");

function isFormBody(body: unknown): body is BodyInit {
  return (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    typeof body === "string"
  );
}

export function apiUrlFor(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiWebSocketUrlFor(path: string): string {
  const url = new URL(apiUrlFor(path), window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text.length === 0 ? "" : `?${text}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response.text();
  return response.json();
}

export async function apiFetch<T>(path: string, opts: ApiFetchOptions<T> = {}): Promise<T> {
  const { body, headers, schema, ...init } = opts;
  const requestHeaders = new Headers(headers);
  let requestBody: BodyInit | undefined;
  if (body !== undefined) {
    if (isFormBody(body)) {
      requestBody = body;
    } else {
      requestBody = JSON.stringify(body);
      requestHeaders.set("Content-Type", "application/json");
    }
  }

  const requestInit: RequestInit = {
    credentials: "include",
    ...init,
    headers: requestHeaders,
    ...(requestBody === undefined ? {} : { body: requestBody }),
  };
  const response = await fetch(apiUrlFor(path), requestInit);
  const payload = await parseResponse(response);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : response.statusText;
    throw new ApiError(response.status, message || `HTTP ${response.status}`, payload);
  }
  return schema === undefined ? (payload as T) : schema.parse(payload);
}

async function blobArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read blob as bytes."));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read blob.")),
    );
    reader.readAsArrayBuffer(file);
  });
}

export async function sha256Hex(file: Blob): Promise<string> {
  const bytes = await blobArrayBuffer(file);
  // Node 22's WebIDL crypto rejects raw Buffer / non-spec-conforming
  // ArrayBuffer-like values. Wrapping in a Uint8Array view normalizes to
  // a recognized TypedArray on both browsers and Node test envs.
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadBlobToSas(uploadUrl: string, file: Blob): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "audio/flac",
      "x-ms-blob-type": "BlockBlob",
    },
    body: file,
  });
  if (!response.ok) throw new ApiError(response.status, response.statusText || "SAS upload failed");
}

export const status = {
  current: () => apiFetch<BoothStatus>("/v1/status", { schema: BoothStatusSchema }),
  history: (params: { readonly since?: string; readonly limit?: number } = {}) =>
    apiFetch<StatusHistory>(
      `/v1/status/history${query({ since: params.since, limit: params.limit ?? 50 })}`,
      { schema: StatusHistorySchema },
    ),
};

export const uploads = {
  sas: (input: UploadSasRequest) =>
    apiFetch<UploadSlot>("/v1/uploads/sas", {
      method: "POST",
      body: UploadSasRequestSchema.parse(input),
      schema: UploadSlotSchema,
    }),
};

export const questions = {
  list: (
    params: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly status?: QuestionStatus | "any";
      readonly installationId?: InstallationScope;
    } = {},
  ) =>
    apiFetch<QuestionList>(
      `/v1/questions${query({ cursor: params.cursor, limit: params.limit ?? 50, status: params.status, installationId: params.installationId })}`,
      { schema: QuestionListSchema },
    ),
  // The id list is the whole filter, so ask for as many rows back as ids sent —
  // the endpoint's default page size is smaller than a batch and would silently
  // drop the tail.
  listByIds: (ids: readonly string[]) =>
    apiFetch<QuestionList>(`/v1/questions${query({ ids: ids.join(","), limit: ids.length })}`, {
      schema: QuestionListSchema,
    }),
  create: (input: QuestionCreate) =>
    apiFetch<Question>("/v1/questions", {
      method: "POST",
      body: QuestionCreateSchema.parse(input),
      schema: QuestionSchema,
    }),
  activate: (id: string) =>
    apiFetch<Question>(`/v1/questions/${id}/activate`, { method: "POST", schema: QuestionSchema }),
  deactivate: (id: string) =>
    apiFetch<Question>(`/v1/questions/${id}/deactivate`, {
      method: "POST",
      schema: QuestionSchema,
    }),
  delete: (id: string) => apiFetch<void>(`/v1/questions/${id}`, { method: "DELETE" }),
};

export const instructions = {
  list: (
    params: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly status?: InstructionStatus;
    } = {},
  ) =>
    apiFetch<InstructionList>(
      `/v1/instructions${query({ cursor: params.cursor, limit: params.limit ?? 50, status: params.status })}`,
      { schema: InstructionListSchema },
    ),
  create: (input: InstructionCreate) =>
    apiFetch<Instruction>("/v1/instructions", {
      method: "POST",
      body: InstructionCreateSchema.parse(input),
      schema: InstructionSchema,
    }),
  activate: (id: string) =>
    apiFetch<Instruction>(`/v1/instructions/${id}/activate`, {
      method: "POST",
      schema: InstructionSchema,
    }),
  deactivate: (id: string) =>
    apiFetch<Instruction>(`/v1/instructions/${id}/deactivate`, {
      method: "POST",
      schema: InstructionSchema,
    }),
  delete: (id: string) => apiFetch<void>(`/v1/instructions/${id}`, { method: "DELETE" }),
};

export const messages = {
  list: (
    params: {
      readonly status?: MessageStatus;
      readonly since?: string;
      readonly limit?: number;
      readonly installationId?: InstallationScope;
    } = {},
  ) =>
    apiFetch<MessageList>(
      `/v1/messages${query({ status: params.status, since: params.since, limit: params.limit ?? 50, installationId: params.installationId })}`,
      { schema: MessageListSchema },
    ),
  get: (id: string) => apiFetch<Message>(`/v1/messages/${id}`, { schema: MessageSchema }),
  delete: (id: string) => apiFetch<void>(`/v1/messages/${id}`, { method: "DELETE" }),
  transcriptions: (id: string) =>
    apiFetch<TranscriptionList>(`/v1/messages/${id}/transcriptions`, {
      schema: TranscriptionListSchema,
    }),
  transcribe: (id: string) =>
    apiFetch<Transcription>(`/v1/messages/${id}/transcribe`, {
      method: "POST",
      schema: TranscriptionSchema,
    }),
  moderate: (id: string) =>
    apiFetch<Moderation>(`/v1/messages/${id}/moderate`, {
      method: "POST",
      schema: ModerationSchema,
    }),
  decide: (id: string, input: MessageDecision) =>
    apiFetch<Message>(`/v1/messages/${id}/decision`, {
      method: "POST",
      body: MessageDecisionSchema.parse(input),
      schema: MessageSchema,
    }),
};

export const messageProcessing = {
  summary: () =>
    apiFetch<MessageProcessingSummary>("/v1/message-processing/summary", {
      schema: MessageProcessingSummarySchema,
    }),
  claim: (input: Partial<MessageProcessingClaimRequest> = {}) =>
    apiFetch<MessageProcessingClaimResponse>("/v1/message-processing/claim", {
      method: "POST",
      body: MessageProcessingClaimRequestSchema.parse(input),
      schema: MessageProcessingClaimResponseSchema,
    }),
  heartbeat: (id: string, input: MessageProcessingHeartbeat) =>
    apiFetch<{ ok: boolean; leaseExpiresAt: string }>(`/v1/message-processing/${id}/heartbeat`, {
      method: "POST",
      body: MessageProcessingHeartbeatSchema.parse(input),
    }),
  complete: (id: string, input: MessageProcessingComplete) =>
    apiFetch<{ message: Message; needs: string[] }>(`/v1/message-processing/${id}/complete`, {
      method: "POST",
      body: MessageProcessingCompleteSchema.parse(input),
    }),
  release: (id: string, input: { readonly leaseToken: string }) =>
    apiFetch<void>(`/v1/message-processing/${id}/release`, {
      method: "POST",
      body: MessageProcessingLeaseTokenSchema.parse(input),
    }),
  fail: (id: string, input: MessageProcessingFail) =>
    apiFetch<{ ok: boolean; terminal: boolean }>(`/v1/message-processing/${id}/fail`, {
      method: "POST",
      body: MessageProcessingFailSchema.parse(input),
    }),
};

export const apiTokens = {
  list: () => apiFetch<readonly ApiToken[]>("/v1/api-tokens", { schema: ApiTokenListSchema }),
  create: (input: CreateApiTokenRequest) =>
    apiFetch<ApiTokenCreated>("/v1/api-tokens", {
      method: "POST",
      body: CreateApiTokenRequestSchema.parse(input),
      schema: ApiTokenCreatedSchema,
    }),
  revoke: (id: string) => apiFetch<void>(`/v1/api-tokens/${id}`, { method: "DELETE" }),
  usage: (id: string, days = 30) =>
    apiFetch<readonly ApiTokenUsageBucket[]>(`/v1/api-tokens/${id}/usage${query({ days })}`, {
      schema: ApiTokenUsageListSchema,
    }),
};

export const auth = {
  me: () => apiFetch<OperatorMe>("/v1/auth/me", { schema: OperatorMeSchema }),
  logout: async () => {
    await fetch(apiUrlFor("/v1/auth/logout"), {
      method: "POST",
      credentials: "include",
      redirect: "manual",
    });
  },
};

export interface EventsListParams {
  readonly boothId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly type?: readonly BoothEventType[];
  readonly sessionId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly installationId?: InstallationScope;
}

const buildEventsQuery = (params: EventsListParams): string => {
  const search = new URLSearchParams();
  if (params.boothId) search.set("boothId", params.boothId);
  if (params.since) search.set("since", params.since);
  if (params.until) search.set("until", params.until);
  if (params.sessionId) search.set("sessionId", params.sessionId);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.installationId) search.set("installationId", params.installationId);
  search.set("limit", String(params.limit ?? 100));
  for (const type of params.type ?? []) search.append("type", type);
  const text = search.toString();
  return text.length === 0 ? "" : `?${text}`;
};

export const events = {
  list: (params: EventsListParams = {}) =>
    apiFetch<BoothEventList>(`/v1/events${buildEventsQuery(params)}`, {
      schema: BoothEventListSchema,
    }),
};

export const sessions = {
  list: (
    params: {
      readonly boothId?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly installationId?: InstallationScope;
    } = {},
  ) =>
    apiFetch<CallSessionList>(
      `/v1/sessions${query({ boothId: params.boothId, cursor: params.cursor, limit: params.limit ?? 100, installationId: params.installationId })}`,
      {
        schema: CallSessionListSchema,
      },
    ),
  get: (id: string) =>
    apiFetch<CallSessionDetail>(`/v1/sessions/${id}`, { schema: CallSessionDetailSchema }),
};

export type AuditLogTargetParams = {
  readonly cursor?: string;
  readonly limit?: number;
};

export type AuditLogListParams = {
  readonly action?: string;
  readonly actorType?: string;
  readonly actorUserId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly ip?: string;
  readonly since?: string;
  readonly until?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export const auditLogs = {
  list: (params: AuditLogListParams = {}) =>
    apiFetch<AuditLogPage>(
      `/v1/audit-logs${query({
        action: params.action,
        actorType: params.actorType,
        actorUserId: params.actorUserId,
        targetType: params.targetType,
        targetId: params.targetId,
        ip: params.ip,
        since: params.since,
        until: params.until,
        cursor: params.cursor,
        limit: params.limit ?? 50,
      })}`,
      { schema: AuditLogPageSchema },
    ),
  forTarget: (targetType: string, targetId: string, params: AuditLogTargetParams = {}) =>
    apiFetch<AuditLogPage>(
      `/v1/audit-logs/targets/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}${query(
        { cursor: params.cursor, limit: params.limit ?? 50 },
      )}`,
      { schema: AuditLogPageSchema },
    ),
};

export const system = {
  current: (boothId: string) =>
    apiFetch<BoothSystemSnapshotEnvelope>(`/v1/system/current${query({ boothId })}`, {
      schema: BoothSystemSnapshotEnvelopeSchema,
    }),
};

// A metrics time selection: either a preset window, or an explicit custom
// range. For custom, `start === null` means "from the beginning" and
// `end === null` means "now" (kept live so a saved filter stays current).
export type StatsRangeSelection =
  | { readonly kind: "preset"; readonly window: StatsWindow }
  | { readonly kind: "custom"; readonly start: string | null; readonly end: string | null };

const statsOverviewQuery = (selection: StatsRangeSelection, scope?: InstallationScope): string => {
  const base =
    selection.kind === "preset"
      ? { window: selection.window }
      : { start: selection.start ?? undefined, end: selection.end ?? "now" };
  return query({ ...base, installationId: scope });
};

const MetricFilterListSchema = z.object({ items: z.array(MetricFilterSchema) });

export const stats = {
  overview: (selection: StatsRangeSelection, scope?: InstallationScope) =>
    apiFetch<StatsOverview>(`/v1/stats/overview${statsOverviewQuery(selection, scope)}`, {
      schema: StatsOverviewSchema,
    }),
  summary: (scope?: InstallationScope) =>
    apiFetch<StatsSummary>(`/v1/stats/summary${query({ installationId: scope })}`, {
      schema: StatsSummarySchema,
    }),
};

export const metricFilters = {
  list: () =>
    apiFetch<{ items: MetricFilter[] }>("/v1/stats/filters", { schema: MetricFilterListSchema }),
  create: (input: MetricFilterCreate) =>
    apiFetch<MetricFilter>("/v1/stats/filters", {
      method: "POST",
      body: MetricFilterCreateSchema.parse(input),
      schema: MetricFilterSchema,
    }),
  update: (id: string, input: MetricFilterCreate) =>
    apiFetch<MetricFilter>(`/v1/stats/filters/${id}`, {
      method: "PUT",
      body: MetricFilterCreateSchema.parse(input),
      schema: MetricFilterSchema,
    }),
  remove: (id: string) => apiFetch<void>(`/v1/stats/filters/${id}`, { method: "DELETE" }),
};

export type AdminImportSummary = {
  rows: Record<string, number>;
  blobsUploaded: number;
  blobsSkipped: number;
};

export const adminData = {
  // Full backup download. Uses a raw fetch (not apiFetch) so we can stream the
  // tar archive as a Blob and trigger a browser download.
  export: async (): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(apiUrlFor("/v1/admin/data/export"), { credentials: "include" });
    if (!response.ok) {
      throw new ApiError(response.status, `export failed (HTTP ${response.status})`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? "telephone-booth-export.tar" };
  },
  import: (archive: Blob) =>
    apiFetch<AdminImportSummary>("/v1/admin/data/import", {
      method: "POST",
      body: archive,
      headers: { "Content-Type": "application/x-tar" },
    }),
};

export const installations = {
  list: () => apiFetch<InstallationList>("/v1/installations", { schema: InstallationListSchema }),
  current: () =>
    apiFetch<Installation>("/v1/installations/current", { schema: InstallationSchema }),
  get: (id: string) =>
    apiFetch<Installation>(`/v1/installations/${id}`, { schema: InstallationSchema }),
  create: (input: InstallationCreate) =>
    apiFetch<Installation>("/v1/installations", {
      method: "POST",
      body: InstallationCreateSchema.parse(input),
      schema: InstallationSchema,
    }),
  update: (id: string, input: InstallationUpdate) =>
    apiFetch<Installation>(`/v1/installations/${id}`, {
      method: "PATCH",
      body: InstallationUpdateSchema.parse(input),
      schema: InstallationSchema,
    }),
  end: (id: string, input: InstallationEnd) =>
    apiFetch<Installation>(`/v1/installations/${id}/end`, {
      method: "POST",
      body: InstallationEndSchema.parse(input),
      schema: InstallationSchema,
    }),
  purge: (id: string, confirmName: string) =>
    apiFetch<InstallationPurgeResult>(`/v1/installations/${id}`, {
      method: "DELETE",
      body: InstallationPurgeSchema.parse({ confirmName }),
      schema: InstallationPurgeResultSchema,
    }),
  // Per-era archive download. Mirrors `adminData.export`: a raw fetch so the
  // tar archive streams as a Blob for a browser download.
  exportArchive: async (id: string): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(apiUrlFor(`/v1/installations/${id}/export`), {
      credentials: "include",
    });
    if (!response.ok) {
      throw new ApiError(response.status, `export failed (HTTP ${response.status})`);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? "installation-export.tar" };
  },
};

export const apiQueryKeys = {
  me: ["auth", "me"] as const,
  status: ["status", "current"] as const,
  statusHistory: ["status", "history"] as const,
  questions: (filter?: QuestionStatus | "all" | "any", scope?: InstallationScope) =>
    ["questions", "list", filter ?? "all", scope ?? null] as const,
  instructions: (filter?: InstructionStatus | "all") =>
    ["instructions", "list", filter ?? "all"] as const,
  messages: (filter?: MessageStatus | "all", scope?: InstallationScope) =>
    ["messages", "list", filter ?? "all", scope ?? null] as const,
  message: (id: string) => ["messages", id] as const,
  transcriptions: (id: string) => ["messages", id, "transcriptions"] as const,
  tokens: ["api-tokens", "list"] as const,
  tokenUsage: (id: string) => ["api-tokens", id, "usage"] as const,
  events: (params: EventsListParams) => ["events", "list", params] as const,
  sessions: (boothId?: string, scope?: InstallationScope) =>
    ["sessions", "list", boothId ?? null, scope ?? null] as const,
  session: (id: string) => ["sessions", id] as const,
  system: (boothId: string) => ["system", boothId] as const,
  statsOverview: (selection: StatsRangeSelection, scope?: InstallationScope) =>
    ["stats", "overview", selection, scope ?? null] as const,
  statsSummary: (scope?: InstallationScope) => ["stats", "summary", scope ?? null] as const,
  metricFilters: ["stats", "filters"] as const,
  auditLogs: (params: AuditLogListParams) => ["audit-logs", "list", params] as const,
  auditLogTarget: (targetType: string, targetId: string, params: AuditLogTargetParams = {}) =>
    ["audit-logs", "target", targetType, targetId, params] as const,
  installations: ["installations", "list"] as const,
  installationCurrent: ["installations", "current"] as const,
  installation: (id: string) => ["installations", id] as const,
};

export function useAuditLogs(params: AuditLogListParams = {}) {
  return useQuery({
    queryKey: apiQueryKeys.auditLogs(params),
    queryFn: () => auditLogs.list(params),
    refetchInterval: 30_000,
  });
}

// Trail for one resource. Admin-only server-side, so callers should gate the
// query on `isAdmin` rather than rendering a 403.
export function useAuditLogsForTarget(
  targetType: string,
  targetId: string | undefined,
  enabled = true,
  params: AuditLogTargetParams = {},
) {
  return useQuery({
    queryKey: apiQueryKeys.auditLogTarget(targetType, targetId ?? "", params),
    queryFn: () => auditLogs.forTarget(targetType, targetId ?? "", params),
    enabled: enabled && typeof targetId === "string" && targetId.length > 0,
  });
}

export function useEventsList(params: EventsListParams = {}) {
  return useQuery({
    queryKey: apiQueryKeys.events(params),
    queryFn: () => events.list(params),
    refetchInterval: 10_000,
  });
}

export function useSessionsList(boothId?: string, scope?: InstallationScope) {
  return useQuery({
    queryKey: apiQueryKeys.sessions(boothId, scope),
    queryFn: () =>
      sessions.list({
        ...(boothId ? { boothId } : {}),
        ...(scope ? { installationId: scope } : {}),
        limit: 100,
      }),
    refetchInterval: 10_000,
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: apiQueryKeys.session(id ?? ""),
    queryFn: () => sessions.get(id ?? ""),
    enabled: typeof id === "string" && id.length > 0,
  });
}

export function useSystemCurrent(boothId: string | undefined) {
  return useQuery({
    queryKey: apiQueryKeys.system(boothId ?? ""),
    queryFn: () => system.current(boothId ?? ""),
    enabled: typeof boothId === "string" && boothId.length > 0,
    refetchInterval: 5_000,
  });
}

export function useStatsOverview(selection: StatsRangeSelection, scope?: InstallationScope) {
  // A custom range with a fixed end never changes, so polling it just reruns
  // the (deliberately un-cached) server aggregation. Only keep refetching while
  // the selection is "live": a preset window, or a custom range ending at "now"
  // (end === null).
  const isLive = selection.kind !== "custom" || selection.end === null;
  return useQuery({
    queryKey: apiQueryKeys.statsOverview(selection, scope),
    queryFn: () => stats.overview(selection, scope),
    refetchInterval: isLive ? 30_000 : false,
  });
}

export function useStatsSummary(scope?: InstallationScope) {
  return useQuery({
    queryKey: apiQueryKeys.statsSummary(scope),
    queryFn: () => stats.summary(scope),
    refetchInterval: 30_000,
  });
}

export function useMetricFilters() {
  return useQuery({
    queryKey: apiQueryKeys.metricFilters,
    queryFn: () => metricFilters.list(),
  });
}

export function useCreateMetricFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MetricFilterCreate) => metricFilters.create(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.metricFilters }),
  });
}

export function useUpdateMetricFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MetricFilterCreate }) =>
      metricFilters.update(id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.metricFilters }),
  });
}

export function useDeleteMetricFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => metricFilters.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.metricFilters }),
  });
}

export function useStatusCurrent(options?: { paused?: boolean }) {
  return useQuery({
    queryKey: apiQueryKeys.status,
    queryFn: status.current,
    refetchInterval: options?.paused ? false : 5_000,
  });
}

export function useStatusHistory(options?: { paused?: boolean }) {
  return useQuery({
    queryKey: apiQueryKeys.statusHistory,
    queryFn: () => status.history({ limit: STATUS_HISTORY_LIMIT }),
    refetchInterval: options?.paused ? false : 5_000,
  });
}

export function useQuestionsList(
  filter: QuestionStatus | "all" | "any" = "all",
  options: { readonly installationId?: InstallationScope } = {},
) {
  const statusParam: QuestionStatus | "any" | undefined =
    filter === "any"
      ? "any"
      : QuestionStatusSchema.safeParse(filter).success
        ? (filter as QuestionStatus)
        : undefined;
  return useQuery({
    queryKey: apiQueryKeys.questions(filter, options.installationId),
    queryFn: () =>
      questions.list({
        ...(statusParam === undefined ? {} : { status: statusParam }),
        ...(options.installationId ? { installationId: options.installationId } : {}),
        limit: 100,
      }),
  });
}

const QUESTIONS_BY_IDS_BATCH = 200;

// Resolve a specific set of question ids regardless of installation scope or
// status. `GET /v1/questions?ids=…` is the documented lookup for
// cross-era/archived questions; without it, historical prompts render as raw
// UUIDs because `list` hides archived rows and is scoped to the active era.
export function useQuestionsByIds(ids: readonly string[]) {
  const sortedIds = useMemo(
    () => Array.from(new Set(ids.filter((id) => id.length > 0))).sort(),
    [ids],
  );
  return useQuery({
    queryKey: ["questions", "by-ids", sortedIds] as const,
    queryFn: async () => {
      if (sortedIds.length === 0) return [] as Question[];
      const batches: string[][] = [];
      for (let i = 0; i < sortedIds.length; i += QUESTIONS_BY_IDS_BATCH) {
        batches.push(sortedIds.slice(i, i + QUESTIONS_BY_IDS_BATCH));
      }
      const responses = await Promise.all(batches.map((batch) => questions.listByIds(batch)));
      return responses.flatMap((response) => response.items);
    },
    enabled: sortedIds.length > 0,
  });
}

export function useCreateQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: questions.create,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["questions", "list"] }),
  });
}

export function useDeleteQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: questions.delete,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["questions", "list"] }),
  });
}

export function useActivateQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: questions.activate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["questions", "list"] }),
  });
}

export function useDeactivateQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: questions.deactivate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["questions", "list"] }),
  });
}

export function useInstructionsList(filter: InstructionStatus | "all" = "all") {
  const statusFilter = InstructionStatusSchema.safeParse(filter).success
    ? (filter as InstructionStatus)
    : undefined;
  return useQuery({
    queryKey: apiQueryKeys.instructions(filter),
    queryFn: () =>
      instructions.list({
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        limit: 100,
      }),
  });
}

export function useCreateInstruction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: instructions.create,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["instructions", "list"] }),
  });
}

export function useDeleteInstruction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: instructions.delete,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["instructions", "list"] }),
  });
}

export function useActivateInstruction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: instructions.activate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["instructions", "list"] }),
  });
}

export function useDeactivateInstruction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: instructions.deactivate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["instructions", "list"] }),
  });
}

export interface MessagesListOptions {
  readonly limit?: number;
  readonly enabled?: boolean;
  readonly installationId?: InstallationScope;
}

// The status socket is process-local. This bounded REST refresh lets a console
// connected to another API replica converge promptly when it misses a message
// envelope, while the socket remains the low-latency path.
const MESSAGE_INVALIDATION_POLL_MS = 5_000;

export function useMessagesList(filter: MessageStatus | "all", options: MessagesListOptions = {}) {
  const limit = options.limit ?? 100;
  const statusFilter = MessageStatusSchema.safeParse(filter).success
    ? (filter as MessageStatus)
    : undefined;
  return useQuery({
    queryKey: [...apiQueryKeys.messages(filter, options.installationId), limit],
    queryFn: () =>
      messages.list({
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        ...(options.installationId ? { installationId: options.installationId } : {}),
        limit,
      }),
    enabled: options.enabled ?? true,
    refetchInterval: MESSAGE_INVALIDATION_POLL_MS,
  });
}

export function useMessage(id: string) {
  return useQuery({
    queryKey: apiQueryKeys.message(id),
    queryFn: () => messages.get(id),
    refetchInterval: MESSAGE_INVALIDATION_POLL_MS,
  });
}

export function useMessageProcessingSummary() {
  return useQuery({
    queryKey: ["message-processing", "summary"],
    queryFn: messageProcessing.summary,
    refetchInterval: MESSAGE_INVALIDATION_POLL_MS,
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: messages.delete,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

export function useMessageTranscriptions(id: string) {
  return useQuery({
    queryKey: apiQueryKeys.transcriptions(id),
    queryFn: () => messages.transcriptions(id),
    refetchInterval: MESSAGE_INVALIDATION_POLL_MS,
  });
}

export function useRetranscribeMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => messages.transcribe(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.message(id) });
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.transcriptions(id) });
      void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
    },
  });
}

export function useRemoderateMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => messages.moderate(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.message(id) });
      void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
    },
  });
}

// Human moderation decision. The AI moderation result is only ever an advisory
// suggestion — approving or rejecting a message is always an explicit operator
// action, recorded against the acting operator on the server.
export function useDecideMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: MessageDecision }) =>
      messages.decide(id, input),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.message(id) });
      void queryClient.invalidateQueries({ queryKey: ["messages", "list"] });
    },
  });
}

export function useApiTokensList() {
  return useQuery({ queryKey: apiQueryKeys.tokens, queryFn: apiTokens.list });
}

export function useCreateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: apiTokens.create,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.tokens }),
  });
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: apiTokens.revoke,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.tokens }),
  });
}

export function useApiTokenUsage(id: string) {
  return useQuery({
    queryKey: apiQueryKeys.tokenUsage(id),
    queryFn: () => apiTokens.usage(id),
    staleTime: 30_000,
  });
}

export function useAuthMeQuery() {
  return useQuery({ queryKey: apiQueryKeys.me, queryFn: auth.me, retry: false });
}

export function useInstallationsList() {
  return useQuery({ queryKey: apiQueryKeys.installations, queryFn: installations.list });
}

// After a rollover (start/end) every era-scoped read is stale: the active
// installation moved, frozen summaries changed, and live stats now belong to a
// different era. Invalidate broadly so the whole console re-scopes.
export function invalidateInstallationScopedQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({ queryKey: ["installations"] });
  void queryClient.invalidateQueries({ queryKey: ["stats"] });
  // Whole prefixes, not just the lists: a rollover rejects queued messages and
  // closes open sessions, and a detail view has no polling of its own, so an
  // operator sitting on one would otherwise keep seeing the pre-rollover row.
  void queryClient.invalidateQueries({ queryKey: ["messages"] });
  void queryClient.invalidateQueries({ queryKey: ["sessions"] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: ["questions"] });
}

export function useCreateInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InstallationCreate) => installations.create(input),
    onSuccess: () => invalidateInstallationScopedQueries(queryClient),
  });
}

export function useEndInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: InstallationEnd }) =>
      installations.end(id, input),
    onSuccess: () => invalidateInstallationScopedQueries(queryClient),
  });
}

// Renaming (or re-noting/re-locating) the active installation. Only the
// installation row itself changes — no scoped counts move — so this
// invalidates just the installations list and the touched detail.
export function useUpdateInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: InstallationUpdate }) =>
      installations.update(id, input),
    onSuccess: (_data, { id }) => {
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.installations });
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.installation(id) });
      void queryClient.invalidateQueries({ queryKey: apiQueryKeys.installationCurrent });
    },
  });
}

export function usePurgeInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, confirmName }: { readonly id: string; readonly confirmName: string }) =>
      installations.purge(id, confirmName),
    onSuccess: () => invalidateInstallationScopedQueries(queryClient),
  });
}
