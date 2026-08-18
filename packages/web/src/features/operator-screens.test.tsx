import axe from "axe-core";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { App } from "../app/App.js";
import { createAppRouter } from "../app/router.js";
import { ApiError, apiFetch, sha256Hex } from "../lib/api-client.js";
import {
  clearDebugConnectionTokens,
  readDebugConnectionToken,
  writeDebugConnectionToken,
} from "../lib/debug-client.js";

const operator = {
  id: "user-1",
  email: "operator@example.com",
  name: "Jane Operator",
  groups: ["operators"],
  isAdmin: true,
  providerName: "Authentik",
};
const questionId = "11111111-1111-4111-8111-111111111111";
const questionTwoId = "11111111-1111-4111-8111-111111111112";
const messageId = "22222222-2222-4222-8222-222222222222";
const tokenId = "33333333-3333-4333-8333-333333333333";
const audioFileId = "44444444-4444-4444-8444-444444444444";
const sha = "a".repeat(64);

const question = {
  id: questionId,
  prompt: "What did the city sound like today?",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  audio: { url: "https://media.example/question.flac", sha256: sha, durationMs: 12000 },
};
const questionTwo = { ...question, id: questionTwoId, prompt: "Who are you calling?" };
const message = {
  id: messageId,
  status: "received",
  questionId,
  notes: "front step",
  createdAt: "2026-01-02T00:00:00.000Z",
  receivedAt: "2026-01-02T00:01:00.000Z",
  audio: { url: "https://media.example/message.flac", sha256: sha, durationMs: 9000 },
};
const transcriptionBase = {
  id: "55555555-5555-4555-8555-555555555555",
  messageId,
  model: null,
  text: null,
  language: null,
  durationMs: 9000,
  latencyMs: null,
  error: null,
  requestedById: null,
  createdAt: "2026-01-02T00:02:00.000Z",
  completedAt: null,
  translationStatus: null,
  translatedText: null,
  translatedLanguage: null,
  translationProvider: null,
  translationModel: null,
  translationError: null,
  translationLatencyMs: null,
  translationCompletedAt: null,
};
const pendingPushTranscription = {
  ...transcriptionBase,
  provider: "push",
  status: "pending",
};
const failedTranscription = {
  ...transcriptionBase,
  provider: "openai",
  model: "whisper-1",
  status: "failed",
  error: "audio too large: 40000000 bytes exceeds 26214400 limit",
  completedAt: "2026-01-02T00:03:00.000Z",
};
const token = {
  id: tokenId,
  name: "booth client",
  scope: "operator",
  last4: "1234",
  createdAt: "2026-01-03T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: "2026-01-04T00:00:00.000Z",
  revokedAt: null,
};

let createdQuestion = false;
let lastQuestionsUrl = "";
let questionsUrls: string[] = [];
let activatedQuestionId = "";
let deactivatedQuestionId = "";
let updatedQuestionPrompt = "";
let deletedMessages: string[] = [];
let revokedToken = false;
let lastCreatedTokenScope: string | undefined;
let lastMessageUrl = "";
let messageUrls: string[] = [];
let sessionsUrls: string[] = [];
let eventsUrls: string[] = [];
let statsUrls: string[] = [];
let lastDecision: { decision: string; notes?: string } | null = null;
let uploadReservationBody: unknown;
let blobUploadContentType: string | null = null;
let writeTextMock: ReturnType<typeof vi.fn>;

const server = setupServer(
  http.get("http://localhost/v1/auth/me", () => HttpResponse.json(operator)),
  http.post("http://localhost/v1/auth/logout", () => new HttpResponse(null, { status: 204 })),
  http.get("http://localhost/v1/status", () =>
    HttpResponse.json({
      state: "idle",
      updatedAt: "2026-01-05T00:00:00.000Z",
      currentQuestionId: null,
      currentMessageId: null,
      lastError: null,
    }),
  ),
  http.get("http://localhost/v1/status/history", () =>
    HttpResponse.json({
      items: [
        {
          state: "idle",
          updatedAt: "2026-01-05T00:00:00.000Z",
          currentQuestionId: null,
          currentMessageId: null,
          lastError: null,
        },
      ],
    }),
  ),
  // The vitals strip in the sidebar polls this on every authenticated page.
  // Stub it so test runs aren't littered with unhandled-request warnings;
  // individual tests can override with `server.use(...)` when they need
  // populated snapshot data.
  http.get("http://localhost/v1/system/current", () =>
    HttpResponse.json({ error: "no snapshot" }, { status: 404 }),
  ),
  http.get("http://localhost/v1/system/components/current", () => HttpResponse.json([])),
  http.get("http://localhost/v1/questions", ({ request }) => {
    lastQuestionsUrl = request.url;
    questionsUrls.push(request.url);
    return HttpResponse.json({
      items: createdQuestion ? [questionTwo, question] : [question],
      nextCursor: null,
    });
  }),
  http.post("http://localhost/v1/uploads/sas", async ({ request }) => {
    uploadReservationBody = await request.json();
    return HttpResponse.json(
      {
        uploadUrl: "https://blob.example/upload",
        blobName: "questions/aa/file.flac",
        expiresAt: "2026-01-01T00:10:00.000Z",
        audioFileId,
      },
      { status: 201 },
    );
  }),
  http.put("https://blob.example/upload", ({ request }) => {
    blobUploadContentType = request.headers.get("content-type");
    return new HttpResponse(null, { status: 201 });
  }),
  http.post("http://localhost/v1/questions", () => {
    createdQuestion = true;
    return HttpResponse.json(questionTwo, { status: 201 });
  }),
  http.patch("http://localhost/v1/questions/:id", async ({ params, request }) => {
    const body = (await request.json()) as { prompt: string };
    updatedQuestionPrompt = body.prompt;
    return HttpResponse.json({ ...question, id: String(params.id), prompt: body.prompt });
  }),
  http.delete("http://localhost/v1/questions/:id", () => new HttpResponse(null, { status: 204 })),
  http.post("http://localhost/v1/questions/:id/activate", ({ params }) => {
    activatedQuestionId = String(params.id);
    return HttpResponse.json({ ...question, id: String(params.id), status: "active" });
  }),
  http.post("http://localhost/v1/questions/:id/deactivate", ({ params }) => {
    deactivatedQuestionId = String(params.id);
    return HttpResponse.json({ ...question, id: String(params.id), status: "draft" });
  }),
  http.get("http://localhost/v1/messages", ({ request }) => {
    lastMessageUrl = request.url;
    messageUrls.push(request.url);
    const status = new URL(request.url).searchParams.get("status");
    if (status !== null && status !== message.status) {
      return HttpResponse.json({ items: [] });
    }
    return HttpResponse.json({ items: [message] });
  }),
  http.get("http://localhost/v1/messages/:id", () => HttpResponse.json(message)),
  http.get("http://localhost/v1/messages/:id/transcriptions", () =>
    HttpResponse.json({ items: [] }),
  ),
  http.post("http://localhost/v1/messages/:id/decision", async ({ request }) => {
    lastDecision = (await request.json()) as { decision: string; notes?: string };
    return HttpResponse.json({
      ...message,
      status: lastDecision.decision === "approve" ? "approved" : "rejected",
      decidedAt: "2026-01-02T00:05:00.000Z",
      ...(lastDecision.notes !== undefined ? { notes: lastDecision.notes } : {}),
    });
  }),
  http.delete("http://localhost/v1/messages/:id", ({ params }) => {
    deletedMessages.push(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("http://localhost/v1/api-tokens", () =>
    HttpResponse.json([{ ...token, revokedAt: revokedToken ? "2026-01-05T00:00:00.000Z" : null }]),
  ),
  http.post("http://localhost/v1/api-tokens", async ({ request }) => {
    const body = (await request.json()) as { scope?: string };
    lastCreatedTokenScope = body.scope;
    return HttpResponse.json(
      {
        ...token,
        scope: body.scope ?? "operator",
        plaintext: "booth-token-plaintext",
        lastUsedAt: undefined,
        revokedAt: undefined,
      },
      { status: 201 },
    );
  }),
  http.delete("http://localhost/v1/api-tokens/:id", () => {
    revokedToken = true;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("http://localhost/v1/api-tokens/:id/usage", () =>
    HttpResponse.json([{ date: "2026-01-04", count: 1 }]),
  ),
  http.get("http://localhost/v1/fail", () => HttpResponse.json({ error: "busy" }, { status: 503 })),
  http.get("http://localhost/v1/installations", () =>
    HttpResponse.json({
      items: [
        {
          id: "ee111111-1111-4111-8111-111111111111",
          name: "Spring 2026 residency",
          notes: null,
          location: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-04-01T00:00:00.000Z",
          endedById: null,
          summary: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          isActive: false,
        },
        {
          id: "ee222222-2222-4222-8222-222222222222",
          name: "Summer 2026 tour",
          notes: null,
          location: null,
          startedAt: "2026-06-01T00:00:00.000Z",
          endedAt: null,
          endedById: null,
          summary: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          isActive: true,
        },
      ],
    }),
  ),
  http.get("http://localhost/v1/sessions", ({ request }) => {
    sessionsUrls.push(request.url);
    return HttpResponse.json({ items: [] });
  }),
  http.get("http://localhost/v1/events", ({ request }) => {
    eventsUrls.push(request.url);
    return HttpResponse.json({ items: [], nextCursor: null });
  }),
  http.get("http://localhost/v1/stats/overview", ({ request }) => {
    statsUrls.push(request.url);
    return HttpResponse.json({ error: "unavailable" }, { status: 503 });
  }),
  http.get("http://localhost/v1/stats/summary", () =>
    HttpResponse.json({ error: "x" }, { status: 503 }),
  ),
  http.get("http://localhost/v1/stats/filters", () => HttpResponse.json({ items: [] })),
);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class QuietWebSocket extends EventTarget {
  constructor(readonly url: string) {
    super();
  }
  send(_data: string): void {}
  close(): void {}
}

function installBrowserStubs(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "localStorage", { configurable: true, value: new MemoryStorage() });
  window.scrollTo = vi.fn();
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
  vi.stubGlobal("WebSocket", QuietWebSocket);
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeTextMock },
  });
}

function renderPath(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<App router={router} />);
}

async function expectNoCriticalAxe(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.filter((violation) => violation.impact === "critical")).toHaveLength(0);
}

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());
beforeEach(() => {
  createdQuestion = false;
  lastQuestionsUrl = "";
  questionsUrls = [];
  activatedQuestionId = "";
  deactivatedQuestionId = "";
  updatedQuestionPrompt = "";
  deletedMessages = [];
  revokedToken = false;
  lastCreatedTokenScope = undefined;
  lastMessageUrl = "";
  messageUrls = [];
  sessionsUrls = [];
  eventsUrls = [];
  statsUrls = [];
  lastDecision = null;
  uploadReservationBody = undefined;
  blobUploadContentType = null;
  installBrowserStubs();
  window.localStorage.clear();
  document.documentElement.className = "";
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Auth feature", () => {
  it("renders the login call to action", async () => {
    renderPath("/login");
    expect(await screen.findByText("Sign in to connect")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("You are not logged in.");
    expect(screen.getByText("Sign in with Authentik")).toBeTruthy();
  });

  it("redirects protected routes to login when there is no session", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ error: "unauthenticated" }, { status: 401 }),
      ),
    );
    renderPath("/settings");
    expect(await screen.findByText("Checking the operator line…")).toBeTruthy();
    expect(await screen.findByText("Sign in to connect")).toBeTruthy();
  });

  it("renders account information from /me", async () => {
    renderPath("/settings");
    expect(await screen.findByText("Jane Operator")).toBeTruthy();
    expect(screen.getByText("Authentik")).toBeTruthy();
  });

  it("submits logout as a top-level POST", async () => {
    renderPath("/settings");
    const button = await screen.findByText("Sign out");
    const form = button.closest("form");
    if (!form) throw new Error("missing logout form");
    expect(form).toMatchObject({
      method: "post",
      action: "http://localhost/v1/auth/logout",
    });

    fireEvent.submit(form);
    expect(screen.getByText("Clearing the line…")).toBeTruthy();
  });

  it("clears every in-memory debug token on logout", async () => {
    writeDebugConnectionToken("token-a", "user-1");
    writeDebugConnectionToken("token-b", "user-2");
    writeDebugConnectionToken("token-anon");

    try {
      renderPath("/settings");
      const button = await screen.findByText("Sign out");
      const form = button.closest("form");
      if (!form) throw new Error("missing logout form");

      fireEvent.submit(form);

      expect(readDebugConnectionToken("user-1")).toBe("");
      expect(readDebugConnectionToken("user-2")).toBe("");
      expect(readDebugConnectionToken()).toBe("");
    } finally {
      clearDebugConnectionTokens();
    }
  });

  it("clears in-memory debug tokens on the digit-7 logout shortcut", async () => {
    // Digit 7 builds and submits its own form instead of using LogoutButton,
    // so it needs the same cleanup.
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => undefined);
    writeDebugConnectionToken("token-a", "user-1");
    writeDebugConnectionToken("token-anon");

    try {
      renderPath("/status");
      await screen.findByRole("link", { name: "1 · Status" });

      fireEvent.keyDown(document, { key: "7" });

      expect(submit).toHaveBeenCalled();
      expect(readDebugConnectionToken("user-1")).toBe("");
      expect(readDebugConnectionToken()).toBe("");
    } finally {
      submit.mockRestore();
      clearDebugConnectionTokens();
    }
  });
});

describe("Status feature", () => {
  it("renders the current hook state", async () => {
    renderPath("/status");
    expect(await screen.findByText("On hook")).toBeTruthy();
    expect(screen.getAllByText("idle").length).toBeGreaterThan(0);
  });

  it("opens the state-machine help", async () => {
    renderPath("/status");
    const summary = await screen.findByText("What is this?");
    fireEvent.click(summary);
    expect(screen.getByText(/dial tone/iu)).toBeTruthy();
  });

  it("shows an empty state when no snapshots exist", async () => {
    server.use(
      http.get("http://localhost/v1/status/history", () => HttpResponse.json({ items: [] })),
    );
    renderPath("/status");
    expect(await screen.findByText("On hook")).toBeTruthy();
  });

  it("counts collapsed heartbeats and shows when the run started", async () => {
    server.use(
      http.get("http://localhost/v1/status/history", () =>
        HttpResponse.json({
          items: [
            {
              state: "idle",
              updatedAt: "2026-01-05T00:10:00.000Z",
              firstSeenAt: "2026-01-05T00:00:00.000Z",
              repeatCount: 120,
              currentQuestionId: null,
              currentMessageId: null,
              lastError: null,
            },
            {
              state: "recording",
              updatedAt: "2026-01-04T23:59:00.000Z",
              firstSeenAt: "2026-01-04T23:59:00.000Z",
              repeatCount: 1,
              currentQuestionId: null,
              currentMessageId: null,
              lastError: null,
            },
          ],
        }),
      ),
    );
    renderPath("/status");

    expect(await screen.findByText("×120")).toBeTruthy();
    // The single recording report is counted but gets no "since" sub-line.
    expect(screen.getByText("×1")).toBeTruthy();
    expect(screen.getAllByText(/^since /u)).toHaveLength(1);
  });

  it("shows a busy placard on status errors", async () => {
    server.use(
      http.get("http://localhost/v1/status", () =>
        HttpResponse.json({ error: "busy" }, { status: 500 }),
      ),
    );
    renderPath("/status");
    expect(await screen.findByText("Could not read the booth status line.")).toBeTruthy();
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/status");
    await screen.findByText("On hook");
    await expectNoCriticalAxe(container);
  });
});

describe("Questions feature", () => {
  it("renders the question library", async () => {
    renderPath("/questions");
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
  });

  it("opens the new question dialog", async () => {
    renderPath("/questions");
    fireEvent.click(await screen.findByText("New question"));
    expect(screen.getByRole("dialog", { name: "New question" })).toBeTruthy();
  });

  it("uploads audio and creates a question", async () => {
    renderPath("/questions");
    fireEvent.click(await screen.findByText("New question"));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Who lifted the receiver?" },
    });
    fireEvent.change(screen.getByLabelText("Audio file"), {
      target: { files: [new File(["audio"], "q.wav", { type: "audio/wav" })] },
    });
    const form = screen.getByRole("dialog", { name: "New question" }).querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    await waitFor(() => expect(createdQuestion).toBe(true), { timeout: 3_000 });
    expect(uploadReservationBody).toMatchObject({ contentType: "audio/wav" });
    expect(blobUploadContentType).toBe("audio/wav");
  });

  it("reports unsupported question audio without leaving upload status active", async () => {
    renderPath("/questions");
    fireEvent.click(await screen.findByText("New question"));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Who lifted the receiver?" },
    });
    fireEvent.change(screen.getByLabelText("Audio file"), {
      target: { files: [new File(["audio"], "q.aac", { type: "audio/aac" })] },
    });
    const form = screen.getByRole("dialog", { name: "New question" }).querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(await screen.findByText("The question could not be filed.")).toBeTruthy();
    expect(screen.queryByText("Reserving a clean line for the audio…")).toBeNull();
  });

  it("shows the delete confirmation", async () => {
    renderPath("/questions");
    fireEvent.click((await screen.findAllByText("Delete"))[0]!);
    expect(screen.getByText("Retire this question?")).toBeTruthy();
  });

  it("edits a question prompt", async () => {
    renderPath("/questions");
    fireEvent.click(await screen.findByText("Edit prompt"));
    const input = screen.getByLabelText("Prompt");
    fireEvent.change(input, { target: { value: "What can you hear right now?" } });
    fireEvent.click(screen.getByText("Save prompt"));
    await waitFor(() => expect(updatedQuestionPrompt).toBe("What can you hear right now?"), {
      timeout: 3_000,
    });
  });

  it("reads missing duration from audio metadata", async () => {
    server.use(
      http.get("http://localhost/v1/questions", () =>
        HttpResponse.json({
          items: [{ ...question, audio: { ...question.audio, durationMs: null } }],
          nextCursor: null,
        }),
      ),
    );
    renderPath("/questions");
    const audio = await screen.findByText("Reading length…");
    const player = audio.previousElementSibling as HTMLAudioElement;
    Object.defineProperty(player, "duration", { configurable: true, value: 12 });
    fireEvent.loadedMetadata(player);
    expect(await screen.findByText("12s")).toBeTruthy();
  });

  it("deactivates an active question", async () => {
    renderPath("/questions");
    fireEvent.click(await screen.findByText("Deactivate"));
    await waitFor(() => expect(deactivatedQuestionId).toBe(questionId), { timeout: 3_000 });
  });

  it("activates a draft question", async () => {
    server.use(
      http.get("http://localhost/v1/questions", () =>
        HttpResponse.json({ items: [{ ...question, status: "draft" }], nextCursor: null }),
      ),
    );
    renderPath("/questions");
    fireEvent.click(await screen.findByText("Activate"));
    await waitFor(() => expect(activatedQuestionId).toBe(questionId), { timeout: 3_000 });
  });

  it("filters the library by lifecycle status", async () => {
    renderPath("/questions");
    await screen.findByText("What did the city sound like today?");
    fireEvent.click(screen.getByRole("button", { name: "active", pressed: false }));
    await waitFor(() => expect(lastQuestionsUrl).toContain("status=active"), { timeout: 3_000 });
  });

  it("shows the empty library copy", async () => {
    server.use(
      http.get("http://localhost/v1/questions", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderPath("/questions");
    expect(await screen.findByText("No questions on the line")).toBeTruthy();
  });

  it("hides admin question controls for non-admin operators", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/questions");
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
    expect(screen.queryByText("New question")).toBeNull();
    expect(screen.queryByText("Deactivate")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/questions");
    await screen.findByText("What did the city sound like today?");
    await expectNoCriticalAxe(container);
  });
});

describe("Messages feature", () => {
  it("renders messages with linked prompts", async () => {
    renderPath("/messages");
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
    expect(screen.getAllByText("received").length).toBeGreaterThan(0);
  });

  it("filters rejected messages through the backend status", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByText("Rejected"));
    await waitFor(() => expect(lastMessageUrl).toContain("status=rejected"));
  });

  it("narrows the needs-review filter to received and pending requests", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByText("Needs review"));
    await waitFor(() =>
      expect(messageUrls.some((url) => url.includes("status=received"))).toBe(true),
    );
    await waitFor(() =>
      expect(messageUrls.some((url) => url.includes("status=pending"))).toBe(true),
    );
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
  });

  it("keeps an uploading message out of reach of moderation", async () => {
    server.use(
      http.get("http://localhost/v1/messages", () =>
        HttpResponse.json({ items: [{ ...message, status: "uploading" }] }),
      ),
    );
    renderPath("/messages");
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    fireEvent.click(approve);
    expect(lastDecision).toBeNull();
  });

  // A past era's counters were frozen when it ended, so the API refuses a
  // decision or a delete against it. The queue should not offer either.
  it("offers no moderation actions while browsing an ended era", async () => {
    renderPath("/messages?installationId=ee111111-1111-4111-8111-111111111111");
    expect(await screen.findByText("Archived era — read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    // Reading the recording is still fine.
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  // `installationId=all` lists open and closed eras side by side. The page is
  // not frozen as a whole, but a closed era's row still is: offering Approve
  // there would only earn a 409 from the API.
  it("freezes only the ended era's rows in the all-installations view", async () => {
    server.use(
      http.get("http://localhost/v1/messages", () =>
        HttpResponse.json({
          items: [
            { ...message, installationId: "ee222222-2222-4222-8222-222222222222" },
            {
              ...message,
              id: "77777777-7777-4777-8777-777777777777",
              installationId: "ee111111-1111-4111-8111-111111111111",
            },
          ],
        }),
      ),
    );
    renderPath("/messages?installationId=all");

    await waitFor(() => expect(screen.getByText("Archived era — read-only")).toBeTruthy());
    // Exactly one of the two rows keeps its moderation actions.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByText("Archived era — read-only")).toHaveLength(1);
  });

  it("deletes a message from the queue only after confirmation", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deletedMessages).not.toContain(messageId);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(deletedMessages).toContain(messageId));
  });

  it("approves a message inline from the queue", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lastDecision?.decision).toBe("approve"));
  });

  it("rejects a message inline from the queue", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(lastDecision?.decision).toBe("reject"));
  });

  it("explains that push transcription is waiting on a device", async () => {
    server.use(
      http.get("http://localhost/v1/messages", () =>
        HttpResponse.json({
          items: [{ ...message, latestTranscription: pendingPushTranscription }],
        }),
      ),
    );
    renderPath("/messages");
    expect(await screen.findByText("Waiting on transcription device")).toBeTruthy();
  });

  it("surfaces the reason a transcription failed", async () => {
    server.use(
      http.get("http://localhost/v1/messages", () =>
        HttpResponse.json({
          items: [{ ...message, latestTranscription: failedTranscription }],
        }),
      ),
    );
    renderPath("/messages");
    expect(await screen.findByText("Transcription failed")).toBeTruthy();
    expect(await screen.findByText(/audio too large/)).toBeTruthy();
  });

  it("renders message detail playback", async () => {
    renderPath(`/messages/${messageId}`);
    expect(await screen.findByText("Message playback")).toBeTruthy();
    expect(await screen.findByText("front step")).toBeTruthy();
  });

  it("lets an operator approve a message (human decision)", async () => {
    renderPath(`/messages/${messageId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(lastDecision?.decision).toBe("approve"));
  });

  it("lets an operator reject a message (human decision)", async () => {
    renderPath(`/messages/${messageId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(lastDecision?.decision).toBe("reject"));
  });

  // The detail route has no scope picker, so a row opened from a cross-era
  // list can belong to a closed installation. Its decision controls would only
  // earn a 409.
  it("closes the decision controls on an archived era's message", async () => {
    server.use(
      http.get("http://localhost/v1/messages/:id", () =>
        HttpResponse.json({
          ...message,
          installationId: "ee111111-1111-4111-8111-111111111111",
        }),
      ),
    );
    renderPath(`/messages/${messageId}`);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Archived era — read-only.")).toBeTruthy();
    fireEvent.click(approve);
    expect(lastDecision).toBeNull();
  });

  it("persists the listened toggle", async () => {
    renderPath(`/messages/${messageId}`);
    fireEvent.click(await screen.findByLabelText("Mark as listened"));
    expect(window.localStorage.getItem(`booth.message.listened.${messageId}`)).toBe("true");
  });

  it("passes an installation scope through to the messages fetch", async () => {
    renderPath(`/messages?installationId=ee111111-1111-4111-8111-111111111111`);
    await waitFor(() =>
      expect(
        messageUrls.some((url) =>
          url.includes("installationId=ee111111-1111-4111-8111-111111111111"),
        ),
      ).toBe(true),
    );
  });

  it("resolves prompts for a historical era's messages by looking up the exact question ids", async () => {
    const eraId = "ee111111-1111-4111-8111-111111111111";
    server.use(
      http.get("http://localhost/v1/questions", ({ request }) => {
        questionsUrls.push(request.url);
        const url = new URL(request.url);
        // Mimic the API: `ids` is the whole filter, ignoring installation
        // scope and status entirely. Only return the archived historical
        // question when the request is asking for it by id.
        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
        if (ids.includes(question.id)) {
          return HttpResponse.json({ items: [question], nextCursor: null });
        }
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderPath(`/messages?installationId=${eraId}`);
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
    expect(
      questionsUrls.some((url) => {
        const params = new URL(url).searchParams;
        return params.get("ids")?.split(",").includes(question.id) ?? false;
      }),
    ).toBe(true);
  });

  it("looks up the message detail's question by id so archived prompts still resolve", async () => {
    server.use(
      http.get("http://localhost/v1/questions", ({ request }) => {
        questionsUrls.push(request.url);
        const url = new URL(request.url);
        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
        if (ids.includes(question.id)) {
          return HttpResponse.json({ items: [question], nextCursor: null });
        }
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderPath(`/messages/${messageId}`);
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
    expect(
      questionsUrls.some((url) => {
        const params = new URL(url).searchParams;
        return (
          params.get("ids")?.split(",").includes(question.id) === true &&
          params.get("installationId") === null &&
          params.get("status") === null
        );
      }),
    ).toBe(true);
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/messages");
    await screen.findByRole("list", { name: "Message queue" });
    await expectNoCriticalAxe(container);
  });
});

describe("Tokens feature", () => {
  it("renders existing tokens and usage", async () => {
    renderPath("/tokens");
    expect(await screen.findByText("booth client")).toBeTruthy();
    expect(await screen.findByLabelText("1 usage buckets")).toBeTruthy();
  });

  it("shows the token scope column", async () => {
    renderPath("/tokens");
    expect(await screen.findByText("booth client")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Scope" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "operator" })).toBeTruthy();
  });

  it("issues a worker-scoped token", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("New token"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "worker" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "worker" } });
    fireEvent.click(screen.getByText("Issue token"));
    expect(await screen.findByText("booth-token-plaintext")).toBeTruthy();
    expect(lastCreatedTokenScope).toBe("worker");
  });

  it("issues a monitor-scoped token", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("New token"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "busy bar" } });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "monitor" } });
    fireEvent.click(screen.getByText("Issue token"));
    expect(await screen.findByText("booth-token-plaintext")).toBeTruthy();
    expect(lastCreatedTokenScope).toBe("monitor");
  });

  it("opens the new token dialog", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("New token"));
    expect(screen.getByRole("dialog", { name: "Issue API token" })).toBeTruthy();
  });

  it("shows plaintext once after issuing a token", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("New token"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "new phone" } });
    fireEvent.click(screen.getByText("Issue token"));
    expect(await screen.findByText("booth-token-plaintext")).toBeTruthy();
  });

  it("copies the newly issued token", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("New token"));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "copy phone" } });
    fireEvent.click(screen.getByText("Issue token"));
    fireEvent.click(await screen.findByText("Copy token"));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith("booth-token-plaintext"));
  });

  it("revokes a token after confirmation", async () => {
    renderPath("/tokens");
    fireEvent.click(await screen.findByText("Revoke"));
    fireEvent.click(screen.getByText("Confirm revoke"));
    await waitFor(() => expect(revokedToken).toBe(true));
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/tokens");
    await screen.findByText("API tokens");
    await expectNoCriticalAxe(container);
  });

  it("blocks the tokens screen for non-admin operators", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/tokens");
    expect(await screen.findByText("Admin access required")).toBeTruthy();
    expect(screen.queryByText("API tokens")).toBeNull();
  });

  it("greys out admin-only shortcuts for non-admin operators", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/status");
    const locked = await screen.findByText("4 · Tokens · Admin");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("9 · Debug · Admin")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "4 · Tokens" })).toBeNull();
  });

  it("ignores admin-only digit and chord shortcuts for non-admin operators", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/status");
    await screen.findByText("4 · Tokens · Admin");
    fireEvent.keyDown(document, { key: "4" });
    fireEvent.keyDown(document, { key: "9" });
    fireEvent.keyDown(document, { key: "g" });
    fireEvent.keyDown(document, { key: "d" });
    // Admin-only destinations must stay unreachable from the keyboard.
    await waitFor(() => expect(screen.queryByText("Admin access required")).toBeNull());
    expect(screen.queryByText("API tokens")).toBeNull();
  });

  it("allows admin-only digit shortcuts for admin operators", async () => {
    renderPath("/status");
    await screen.findByRole("link", { name: "4 · Tokens" });
    fireEvent.keyDown(document, { key: "4" });
    expect(await screen.findByText("API tokens")).toBeTruthy();
  });
});

describe("Events feature", () => {
  it("passes an installation scope through to the events fetch", async () => {
    renderPath(`/events?installationId=ee111111-1111-4111-8111-111111111111`);
    await waitFor(() =>
      expect(
        eventsUrls.some((url) =>
          url.includes("installationId=ee111111-1111-4111-8111-111111111111"),
        ),
      ).toBe(true),
    );
  });

  it("re-scopes installation-scoped queries on a WS envelope while off Status", async () => {
    // A controllable stub instead of the default QuietWebSocket so the test
    // can dispatch a synthetic `installation` frame. The bridge is mounted in
    // the root layout, so the invalidation must run even when the operator is
    // parked on Sessions (or any non-Status route).
    class ControllableWebSocket extends EventTarget {
      static instances: ControllableWebSocket[] = [];
      constructor(readonly url: string) {
        super();
        ControllableWebSocket.instances.push(this);
      }
      send(_data: string): void {}
      close(): void {}
    }
    vi.stubGlobal("WebSocket", ControllableWebSocket);

    renderPath("/sessions");
    await waitFor(() => expect(sessionsUrls.length).toBeGreaterThan(0));
    const before = sessionsUrls.length;

    await waitFor(() => expect(ControllableWebSocket.instances.length).toBeGreaterThan(0));
    const socket = ControllableWebSocket.instances[0];
    if (socket === undefined) throw new Error("Provider did not open a WebSocket.");
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "installation",
          installation: {
            id: "ee333333-3333-4333-8333-333333333333",
            name: "Fresh era",
            notes: null,
            location: null,
            startedAt: "2026-08-01T00:00:00.000Z",
            endedAt: null,
            endedById: null,
            summary: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            isActive: true,
          },
        }),
      }),
    );

    await waitFor(() => expect(sessionsUrls.length).toBeGreaterThan(before));
  });

  it("surfaces the payload detail for error events", async () => {
    server.use(
      http.get("http://localhost/v1/events", () =>
        HttpResponse.json({
          items: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              eventId: "evt-1",
              boothId: "booth-01",
              bootId: "88888888-8888-4888-8888-888888888888",
              type: "error",
              occurredAt: "2026-07-17T21:43:20.000Z",
              receivedAt: "2026-07-17T21:43:20.000Z",
              sessionId: null,
              recordingId: null,
              payload: { message: "gpio read timed out" },
              version: "0.3.2",
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    renderPath("/events");
    expect(await screen.findByText("booth-01")).toBeTruthy();
    const summary = screen.getByText("gpio read timed out");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    // Payload JSON is serialized lazily; it must not be present while collapsed.
    expect(details?.querySelector("pre")?.textContent).not.toContain("gpio read timed out");
    (details as HTMLDetailsElement).open = true;
    fireEvent(details as HTMLDetailsElement, new Event("toggle"));
    await waitFor(() =>
      expect(details?.querySelector("pre")?.textContent).toContain("gpio read timed out"),
    );
  });
});

// The default scope of every stats endpoint changed with installations — no
// param now means "this run" rather than "everything ever" — so the scope
// reaching the request is the compatibility guarantee worth pinning down.
describe("Stats feature", () => {
  it("passes an installation scope through to the overview fetch", async () => {
    renderPath(`/stats?installationId=ee111111-1111-4111-8111-111111111111`);
    await waitFor(() =>
      expect(
        statsUrls.some((url) =>
          url.includes("installationId=ee111111-1111-4111-8111-111111111111"),
        ),
      ).toBe(true),
    );
  });

  it("preserves the all-installations escape hatch", async () => {
    renderPath("/stats?installationId=all");
    await waitFor(() =>
      expect(statsUrls.some((url) => url.includes("installationId=all"))).toBe(true),
    );
  });

  it("asks for the active installation when no scope is given", async () => {
    renderPath("/stats");
    await waitFor(() => expect(statsUrls.length).toBeGreaterThan(0));
    expect(statsUrls.every((url) => !url.includes("installationId="))).toBe(true);
  });
});

describe("Sessions feature", () => {
  it("passes an installation scope through to the sessions fetch", async () => {
    renderPath(`/sessions?installationId=ee111111-1111-4111-8111-111111111111`);
    await waitFor(() =>
      expect(
        sessionsUrls.some((url) =>
          url.includes("installationId=ee111111-1111-4111-8111-111111111111"),
        ),
      ).toBe(true),
    );
  });
});

describe("Audit log feature", () => {
  const auditEntry = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action: "message.approve",
    targetType: "message",
    targetId: messageId,
    actorType: "operator",
    actorUserId: "user-1",
    actorTokenId: null,
    actorLabel: "operator@example.com",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    method: "POST",
    path: `/v1/messages/${messageId}/decision`,
    statusCode: 200,
    metadata: { decision: "approve", previousStatus: "pending" },
    createdAt: "2026-07-20T12:00:00.000Z",
  };

  it("shows who acted, from where, and lazily reveals the detail", async () => {
    server.use(
      http.get("http://localhost/v1/audit-logs", () =>
        HttpResponse.json({ items: [auditEntry], nextCursor: null }),
      ),
    );
    renderPath("/audit");
    expect(await screen.findByText("operator@example.com")).toBeTruthy();
    expect(screen.getByText("message.approve")).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();

    const summary = screen.getByText("View detail");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("pre")?.textContent).not.toContain("previousStatus");
    (details as HTMLDetailsElement).open = true;
    fireEvent(details as HTMLDetailsElement, new Event("toggle"));
    await waitFor(() =>
      expect(details?.querySelector("pre")?.textContent).toContain("previousStatus"),
    );
  });

  it("can walk back to newer entries after paging into history", async () => {
    const older = {
      ...auditEntry,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      actorLabel: "someone.else@example.com",
    };
    server.use(
      http.get("http://localhost/v1/audit-logs", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return cursor
          ? HttpResponse.json({ items: [older], nextCursor: null })
          : HttpResponse.json({ items: [auditEntry], nextCursor: "cursor-1" });
      }),
    );
    renderPath("/audit");

    await screen.findByText("operator@example.com");
    const newer = screen.getByRole("button", { name: "← Newer entries" });
    expect((newer as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Older entries →" }));
    expect(await screen.findByText("someone.else@example.com")).toBeTruthy();

    // The last page must not strand the admin on old rows.
    fireEvent.click(screen.getByRole("button", { name: "← Newer entries" }));
    expect(await screen.findByText("operator@example.com")).toBeTruthy();
  });

  it("is admin-only", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/audit");
    expect(await screen.findByRole("heading", { name: "Admin access required" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Audit log" })).toBeNull();
  });
});

describe("Settings feature", () => {
  it("renders theme settings and phone-client connection", async () => {
    renderPath("/settings");
    expect(await screen.findByText("Phone Client Connection")).toBeTruthy();
    expect(screen.getByText("Theme")).toBeTruthy();
  });

  it("shows the admin badge for admin operators", async () => {
    renderPath("/settings");
    await screen.findByText("Jane Operator");
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  it("hides the phone-client connection and admin badge for non-admins", async () => {
    server.use(
      http.get("http://localhost/v1/auth/me", () =>
        HttpResponse.json({ ...operator, isAdmin: false }),
      ),
    );
    renderPath("/settings");
    await screen.findByText("Jane Operator");
    expect(screen.queryByText("Phone Client Connection")).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.getByText("Theme")).toBeTruthy();
  });

  it("toggles high contrast", async () => {
    renderPath("/settings");
    fireEvent.click(await screen.findByLabelText("High contrast glass panels"));
    expect(document.documentElement.classList.contains("booth-high-contrast")).toBe(true);
  });

  it("persists font size selection", async () => {
    renderPath("/settings");
    fireEvent.change(await screen.findByLabelText("Font size"), { target: { value: "large" } });
    expect(window.localStorage.getItem("booth.theme.fontSize")).toBe("large");
  });

  it("persists color theme selection", async () => {
    renderPath("/settings");
    fireEvent.change(await screen.findByLabelText("Color theme"), { target: { value: "dark" } });
    expect(window.localStorage.getItem("booth.theme.mode")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("stores phone-client URL edits", async () => {
    renderPath("/settings");
    fireEvent.change(await screen.findByLabelText("Tailscale URL"), {
      target: { value: "https://phone.example" },
    });
    expect(window.localStorage.getItem("booth.debugConn.user-1")).toContain("phone.example");
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/settings");
    await screen.findByText("Settings");
    await expectNoCriticalAxe(container);
  });
});

describe("About feature", () => {
  it("renders booth lore", async () => {
    renderPath("/about");
    expect(
      await screen.findByText(/control console for a participatory phone installation/iu),
    ).toBeTruthy();
  });

  it("links to GitHub", async () => {
    renderPath("/about");
    expect((await screen.findByText("GitHub")).closest("a")?.getAttribute("href")).toContain(
      "github.com",
    );
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/about");
    await expectNoCriticalAxe(container);
  });
});

describe("API client helpers", () => {
  it("throws typed API errors", async () => {
    await expect(apiFetch("/v1/fail")).rejects.toBeInstanceOf(ApiError);
  });

  it("hashes blobs as lowercase sha256", async () => {
    await expect(sha256Hex(new Blob(["a"]))).resolves.toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});
