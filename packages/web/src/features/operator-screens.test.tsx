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

const operator = {
  id: "user-1",
  email: "operator@example.com",
  name: "Jane Operator",
  groups: ["operators"],
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
const token = {
  id: tokenId,
  name: "booth client",
  last4: "1234",
  createdAt: "2026-01-03T00:00:00.000Z",
  expiresAt: null,
  lastUsedAt: "2026-01-04T00:00:00.000Z",
  revokedAt: null,
};

let createdQuestion = false;
let deletedMessages: string[] = [];
let revokedToken = false;
let lastMessageUrl = "";
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
  http.get("http://localhost/v1/questions", () =>
    HttpResponse.json({
      items: createdQuestion ? [questionTwo, question] : [question],
      nextCursor: null,
    }),
  ),
  http.post("http://localhost/v1/uploads/sas", () =>
    HttpResponse.json(
      {
        uploadUrl: "https://blob.example/upload",
        blobName: "questions/aa/file.flac",
        expiresAt: "2026-01-01T00:10:00.000Z",
        audioFileId,
      },
      { status: 201 },
    ),
  ),
  http.put("https://blob.example/upload", () => new HttpResponse(null, { status: 201 })),
  http.post("http://localhost/v1/questions", () => {
    createdQuestion = true;
    return HttpResponse.json(questionTwo, { status: 201 });
  }),
  http.delete("http://localhost/v1/questions/:id", () => new HttpResponse(null, { status: 204 })),
  http.get("http://localhost/v1/messages", ({ request }) => {
    lastMessageUrl = request.url;
    return HttpResponse.json({ items: [message] });
  }),
  http.get("http://localhost/v1/messages/:id", () => HttpResponse.json(message)),
  http.delete("http://localhost/v1/messages/:id", ({ params }) => {
    deletedMessages.push(String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("http://localhost/v1/api-tokens", () =>
    HttpResponse.json([{ ...token, revokedAt: revokedToken ? "2026-01-05T00:00:00.000Z" : null }]),
  ),
  http.post("http://localhost/v1/api-tokens", () =>
    HttpResponse.json(
      { ...token, plaintext: "booth-token-plaintext", lastUsedAt: undefined, revokedAt: undefined },
      { status: 201 },
    ),
  ),
  http.delete("http://localhost/v1/api-tokens/:id", () => {
    revokedToken = true;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("http://localhost/v1/api-tokens/:id/usage", () =>
    HttpResponse.json([{ date: "2026-01-04", count: 1 }]),
  ),
  http.get("http://localhost/v1/fail", () => HttpResponse.json({ error: "busy" }, { status: 503 })),
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
  deletedMessages = [];
  revokedToken = false;
  lastMessageUrl = "";
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
    fireEvent.change(screen.getByLabelText("Audio file (FLAC)"), {
      target: { files: [new File(["audio"], "q.flac", { type: "audio/flac" })] },
    });
    const form = screen.getByRole("dialog", { name: "New question" }).querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    await waitFor(() => expect(createdQuestion).toBe(true), { timeout: 3_000 });
  });

  it("shows the delete confirmation", async () => {
    renderPath("/questions");
    fireEvent.click((await screen.findAllByText("Delete"))[0]!);
    expect(screen.getByText("Retire this question?")).toBeTruthy();
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

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/questions");
    await screen.findByText("Question library");
    await expectNoCriticalAxe(container);
  });
});

describe("Messages feature", () => {
  it("renders messages with linked prompts", async () => {
    renderPath("/messages");
    expect(await screen.findByText("What did the city sound like today?")).toBeTruthy();
    expect(screen.getAllByText("received").length).toBeGreaterThan(0);
  });

  it("filters failed messages through the rejected backend status", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByText("failed"));
    await waitFor(() => expect(lastMessageUrl).toContain("status=rejected"));
  });

  it("bulk deletes selected messages", async () => {
    renderPath("/messages");
    fireEvent.click(await screen.findByLabelText(`Select message ${messageId}`));
    fireEvent.click(screen.getByText("Delete selected"));
    await waitFor(() => expect(deletedMessages).toContain(messageId));
  });

  it("renders message detail playback", async () => {
    renderPath(`/messages/${messageId}`);
    expect(await screen.findByText("Message playback")).toBeTruthy();
    expect(await screen.findByText("front step")).toBeTruthy();
  });

  it("persists the listened toggle", async () => {
    renderPath(`/messages/${messageId}`);
    fireEvent.click(await screen.findByLabelText("Mark as listened"));
    expect(window.localStorage.getItem(`booth.message.listened.${messageId}`)).toBe("true");
  });

  it("has no critical axe violations", async () => {
    const { container } = renderPath("/messages");
    await screen.findByText("Message queue");
    await expectNoCriticalAxe(container);
  });
});

describe("Tokens feature", () => {
  it("renders existing tokens and usage", async () => {
    renderPath("/tokens");
    expect(await screen.findByText("booth client")).toBeTruthy();
    expect(await screen.findByLabelText("1 usage buckets")).toBeTruthy();
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
});

describe("Settings feature", () => {
  it("renders theme settings and phone-client connection", async () => {
    renderPath("/settings");
    expect(await screen.findByText("Phone Client Connection")).toBeTruthy();
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
