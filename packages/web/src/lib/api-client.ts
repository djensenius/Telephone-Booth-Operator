import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  ApiTokenCreatedSchema,
  ApiTokenSchema,
  ApiTokenUsageBucketSchema,
  BoothStatusSchema,
  CreateApiTokenRequestSchema,
  MessageSchema,
  MessageStatusSchema,
  OperatorMeSchema,
  QuestionCreateSchema,
  QuestionSchema,
  UploadSasRequestSchema,
  UploadSlotSchema,
} from "@telephone-booth-operator/shared";
import type {
  ApiToken,
  ApiTokenCreated,
  ApiTokenUsageBucket,
  BoothStatus,
  CreateApiTokenRequest,
  Message,
  MessageStatus,
  OperatorMe,
  Question,
  QuestionCreate,
  UploadSasRequest,
  UploadSlot,
} from "@telephone-booth-operator/shared";

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
const QuestionListSchema = z.object({ items: z.array(QuestionSchema), nextCursor: z.string().uuid().nullable() });
const MessageListSchema = z.object({ items: z.array(MessageSchema) });
const ApiTokenListSchema = z.array(ApiTokenSchema);
const ApiTokenUsageListSchema = z.array(ApiTokenUsageBucketSchema);

export type StatusHistory = z.infer<typeof StatusHistorySchema>;
export type QuestionList = z.infer<typeof QuestionListSchema>;
export type MessageList = z.infer<typeof MessageListSchema>;

const rawApiBaseUrl = typeof import.meta.env.VITE_API_BASE_URL === "string" ? import.meta.env.VITE_API_BASE_URL : "";
const API_BASE_URL = rawApiBaseUrl.replace(/\/+$/, "");

function isFormBody(body: unknown): body is BodyInit {
  return body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams || typeof body === "string";
}

function urlFor(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
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
  const response = await fetch(urlFor(path), requestInit);
  const payload = await parseResponse(response);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload ? String(payload.error) : response.statusText;
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
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read blob.")));
    reader.readAsArrayBuffer(file);
  });
}

export async function sha256Hex(file: Blob): Promise<string> {
  const bytes = await blobArrayBuffer(file);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
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
  history: (params: { readonly since?: string; readonly limit?: number } = {}) => apiFetch<StatusHistory>(`/v1/status/history${query({ since: params.since, limit: params.limit ?? 50 })}`, { schema: StatusHistorySchema }),
};

export const uploads = {
  sas: (input: UploadSasRequest) => apiFetch<UploadSlot>("/v1/uploads/sas", { method: "POST", body: UploadSasRequestSchema.parse(input), schema: UploadSlotSchema }),
};

export const questions = {
  list: (params: { readonly cursor?: string; readonly limit?: number } = {}) => apiFetch<QuestionList>(`/v1/questions${query({ cursor: params.cursor, limit: params.limit ?? 50 })}`, { schema: QuestionListSchema }),
  create: (input: QuestionCreate) => apiFetch<Question>("/v1/questions", { method: "POST", body: QuestionCreateSchema.parse(input), schema: QuestionSchema }),
  delete: (id: string) => apiFetch<void>(`/v1/questions/${id}`, { method: "DELETE" }),
};

export const messages = {
  list: (params: { readonly status?: MessageStatus; readonly since?: string; readonly limit?: number } = {}) => apiFetch<MessageList>(`/v1/messages${query({ status: params.status, since: params.since, limit: params.limit ?? 50 })}`, { schema: MessageListSchema }),
  get: (id: string) => apiFetch<Message>(`/v1/messages/${id}`, { schema: MessageSchema }),
  delete: (id: string) => apiFetch<void>(`/v1/messages/${id}`, { method: "DELETE" }),
};

export const apiTokens = {
  list: () => apiFetch<readonly ApiToken[]>("/v1/api-tokens", { schema: ApiTokenListSchema }),
  create: (input: CreateApiTokenRequest) => apiFetch<ApiTokenCreated>("/v1/api-tokens", { method: "POST", body: CreateApiTokenRequestSchema.parse(input), schema: ApiTokenCreatedSchema }),
  revoke: (id: string) => apiFetch<void>(`/v1/api-tokens/${id}`, { method: "DELETE" }),
  usage: (id: string, days = 30) => apiFetch<readonly ApiTokenUsageBucket[]>(`/v1/api-tokens/${id}/usage${query({ days })}`, { schema: ApiTokenUsageListSchema }),
};

export const auth = {
  me: () => apiFetch<OperatorMe>("/v1/auth/me", { schema: OperatorMeSchema }),
  logout: async () => {
    await fetch(urlFor("/v1/auth/logout"), { method: "POST", credentials: "include", redirect: "manual" });
  },
};

export const apiQueryKeys = {
  me: ["auth", "me"] as const,
  status: ["status", "current"] as const,
  statusHistory: ["status", "history"] as const,
  questions: ["questions", "list"] as const,
  messages: (filter?: MessageStatus | "all") => ["messages", "list", filter ?? "all"] as const,
  message: (id: string) => ["messages", id] as const,
  tokens: ["api-tokens", "list"] as const,
  tokenUsage: (id: string) => ["api-tokens", id, "usage"] as const,
};

export function useStatusCurrent() {
  return useQuery({ queryKey: apiQueryKeys.status, queryFn: status.current, refetchInterval: 5_000 });
}

export function useStatusHistory() {
  return useQuery({ queryKey: apiQueryKeys.statusHistory, queryFn: () => status.history({ limit: 50 }), refetchInterval: 5_000 });
}

export function useQuestionsList() {
  return useQuery({ queryKey: apiQueryKeys.questions, queryFn: () => questions.list({ limit: 100 }) });
}

export function useCreateQuestion() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: questions.create, onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.questions }) });
}

export function useDeleteQuestion() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: questions.delete, onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.questions }) });
}

export function useMessagesList(filter: MessageStatus | "all") {
  const statusFilter = MessageStatusSchema.safeParse(filter).success ? (filter as MessageStatus) : undefined;
  return useQuery({ queryKey: apiQueryKeys.messages(filter), queryFn: () => messages.list({ ...(statusFilter === undefined ? {} : { status: statusFilter }), limit: 100 }) });
}

export function useMessage(id: string) {
  return useQuery({ queryKey: apiQueryKeys.message(id), queryFn: () => messages.get(id) });
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

export function useDeleteMessages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) => Promise.all(ids.map((id) => messages.delete(id))),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

export function useApiTokensList() {
  return useQuery({ queryKey: apiQueryKeys.tokens, queryFn: apiTokens.list });
}

export function useCreateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: apiTokens.create, onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.tokens }) });
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: apiTokens.revoke, onSuccess: () => void queryClient.invalidateQueries({ queryKey: apiQueryKeys.tokens }) });
}

export function useApiTokenUsage(id: string) {
  return useQuery({ queryKey: apiQueryKeys.tokenUsage(id), queryFn: () => apiTokens.usage(id), staleTime: 30_000 });
}

export function useAuthMeQuery() {
  return useQuery({ queryKey: apiQueryKeys.me, queryFn: auth.me, retry: false });
}
