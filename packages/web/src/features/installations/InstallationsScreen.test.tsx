import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

import type * as ReactRouter from "@tanstack/react-router";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>();
  return { ...actual, useNavigate: () => navigateMock };
});

const { InstallationsScreen } = await import("./InstallationsScreen.js");

const activeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const endedInstallation = {
  id: endedId,
  name: "Spring 2026 residency",
  notes: "First public run",
  location: "Museum atrium",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-03-01T00:00:00.000Z",
  endedById: "user-1",
  summary: {
    calls: 120,
    messages: 88,
    messagesApproved: 70,
    messagesRejected: 12,
    questions: 9,
    events: 540,
    recordedMs: 3_723_000,
    firstActivityAt: "2026-01-02T00:00:00.000Z",
    lastActivityAt: "2026-02-28T00:00:00.000Z",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  isActive: false,
};

const activeInstallation = {
  id: activeId,
  name: "Summer 2026 tour",
  notes: null,
  location: null,
  startedAt: "2026-06-01T00:00:00.000Z",
  endedAt: null,
  endedById: null,
  summary: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  isActive: true,
};

const summary = {
  booth: {},
  messages: { pending: 4, awaitingModeration: 2, receivedToday: 11, latestId: null },
  calls: { today: 6, inProgress: 1 },
  realtime: { wsClients: 3 },
  generatedAt: "2026-06-02T00:00:00.000Z",
};

let createBody: unknown = null;
let endCalledId: string | null = null;

const server = setupServer(
  http.get("http://localhost/v1/stats/summary", () => HttpResponse.json(summary)),
  http.post("http://localhost/v1/installations", async ({ request }) => {
    createBody = await request.json();
    return HttpResponse.json(activeInstallation, { status: 201 });
  }),
  http.post("http://localhost/v1/installations/:id/end", ({ params }) => {
    endCalledId = String(params.id);
    return HttpResponse.json({
      ...activeInstallation,
      endedAt: "2026-07-01T00:00:00.000Z",
      isActive: false,
    });
  }),
);

function renderScreen(items: unknown[]) {
  server.use(http.get("http://localhost/v1/installations", () => HttpResponse.json({ items })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InstallationsScreen />
    </QueryClientProvider>,
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());
beforeEach(() => {
  createBody = null;
  endCalledId = null;
  navigateMock.mockReset();
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

describe("InstallationsScreen", () => {
  it("renders active and ended installations with their summaries", async () => {
    const { container } = renderScreen([activeInstallation, endedInstallation]);

    expect(await screen.findByText("Summer 2026 tour")).toBeTruthy();
    expect(screen.getByText("Spring 2026 residency")).toBeTruthy();
    // Active installation is clearly marked.
    expect(screen.getByText("Active")).toBeTruthy();
    // Frozen counters for the ended era.
    const endedCard = screen.getByText("Spring 2026 residency").closest("section");
    if (endedCard === null) throw new Error("Ended installation card was not rendered.");
    expect(within(endedCard).getByText("120")).toBeTruthy();
    expect(within(endedCard).getByText("1h 02m")).toBeTruthy();
    // Live counters for the active era from /v1/stats/summary.
    await waitFor(() => expect(screen.getByText("Awaiting moderation")).toBeTruthy());
    const activeCard = screen.getByText("Summer 2026 tour").closest("section");
    if (activeCard === null) throw new Error("Active installation card was not rendered.");
    expect(within(activeCard).getByText("6")).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === "critical")).toHaveLength(0);
  });

  it("starts a new installation with copyQuestions defaulting to false", async () => {
    renderScreen([endedInstallation]);

    const nameInput = await screen.findByPlaceholderText("Summer 2027 residency");
    const copyCheckbox = screen.getByLabelText(/Copy the current questions/);
    expect(copyCheckbox).toHaveProperty("checked", false);

    fireEvent.change(nameInput, { target: { value: "Autumn 2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Start installation" }));

    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({ name: "Autumn 2026", copyQuestions: false });
  });

  it("reports an already-active conflict when starting a new installation", async () => {
    server.use(
      http.post("http://localhost/v1/installations", () =>
        HttpResponse.json({ error: "An installation is already active." }, { status: 409 }),
      ),
    );
    renderScreen([endedInstallation]);

    fireEvent.change(await screen.findByPlaceholderText("Summer 2027 residency"), {
      target: { value: "Autumn 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start installation" }));

    expect(await screen.findByText("An installation is already active.")).toBeTruthy();
  });

  it("ends the active installation after confirmation", async () => {
    renderScreen([activeInstallation]);

    fireEvent.click(await screen.findByRole("button", { name: "End installation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm end" }));

    await waitFor(() => expect(endCalledId).toBe(activeId));
  });

  it("reports when the end-installation safety archive fails", async () => {
    server.use(
      http.post("http://localhost/v1/installations/:id/end", () =>
        HttpResponse.json({ error: "archive_failed" }, { status: 503 }),
      ),
    );
    renderScreen([activeInstallation]);

    fireEvent.click(await screen.findByRole("button", { name: "End installation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm end" }));

    expect(await screen.findByText(/safety-net archive could not be written/)).toBeTruthy();
  });
});
