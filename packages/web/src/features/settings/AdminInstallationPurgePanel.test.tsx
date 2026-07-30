import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const { AdminInstallationPurgePanel } = await import("./AdminInstallationPurgePanel.js");

const endedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const activeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const endedInstallation = {
  id: endedId,
  name: "Spring 2026 residency",
  notes: null,
  location: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-03-01T00:00:00.000Z",
  endedById: "user-1",
  summary: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  isActive: false,
};

const activeInstallation = {
  ...endedInstallation,
  id: activeId,
  name: "Live era",
  endedAt: null,
  isActive: true,
};

let purgedWith: { id: string; confirmName: string } | null = null;

const server = setupServer(
  http.get("http://localhost/v1/installations", () =>
    HttpResponse.json({ items: [activeInstallation, endedInstallation] }),
  ),
  http.get(
    "http://localhost/v1/installations/:id/export",
    () =>
      new HttpResponse(new Blob(["tar"]), {
        headers: {
          "content-type": "application/x-tar",
          "content-disposition": 'attachment; filename="spring.tar"',
        },
      }),
  ),
  http.delete("http://localhost/v1/installations/:id", async ({ params, request }) => {
    const body = (await request.json()) as { confirmName: string };
    purgedWith = { id: String(params.id), confirmName: body.confirmName };
    return HttpResponse.json({
      installationId: String(params.id),
      rows: { message: 40, call: 12 },
      blobsDeleted: 30,
      blobsRetained: 2,
      blobFailures: [],
    });
  }),
);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminInstallationPurgePanel />
    </QueryClientProvider>,
  );
}

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());
beforeEach(() => {
  purgedWith = null;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:x"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

describe("AdminInstallationPurgePanel", () => {
  it("only offers ended installations and gates the purge behind archive + name", async () => {
    const { container } = renderPanel();

    const select = await screen.findByLabelText("Installation");
    await screen.findByRole("option", { name: "Spring 2026 residency" });
    // Active installation is never offered.
    expect(screen.queryByRole("option", { name: "Live era" })).toBeNull();
    fireEvent.change(select, { target: { value: endedId } });

    const purgeButton = screen.getByRole("button", {
      name: "Permanently delete installation",
    });
    // Disabled before archive download.
    expect(purgeButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Download archive (required)" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download archive again" })).toBeTruthy(),
    );
    // Still disabled: name not typed.
    expect(purgeButton.hasAttribute("disabled")).toBe(true);

    const confirmInput = screen.getByLabelText(/to confirm/);
    fireEvent.change(confirmInput, { target: { value: "Wrong name" } });
    expect(purgeButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(confirmInput, { target: { value: "Spring 2026 residency" } });
    expect(purgeButton.hasAttribute("disabled")).toBe(false);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });

  it("purges and reports the result counts", async () => {
    renderPanel();

    const select = await screen.findByLabelText("Installation");
    await screen.findByRole("option", { name: "Spring 2026 residency" });
    fireEvent.change(select, { target: { value: endedId } });
    fireEvent.click(screen.getByRole("button", { name: "Download archive (required)" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download archive again" })).toBeTruthy(),
    );

    const confirmInput = screen.getByLabelText(/to confirm/);
    fireEvent.change(confirmInput, { target: { value: "Spring 2026 residency" } });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete installation" }));

    await waitFor(() =>
      expect(purgedWith).toEqual({ id: endedId, confirmName: "Spring 2026 residency" }),
    );
    await waitFor(() => {
      const status = screen.getByText(/Purged installation/);
      expect(status.textContent).toContain("52 rows");
      expect(status.textContent).toContain("30 audio blobs");
      expect(status.textContent).toContain("2 retained");
    });
  });

  it("reports a backend confirmation mismatch without deleting", async () => {
    server.use(
      http.delete("http://localhost/v1/installations/:id", () =>
        HttpResponse.json({ error: "confirm_name_mismatch" }, { status: 400 }),
      ),
    );
    renderPanel();

    const select = await screen.findByLabelText("Installation");
    await screen.findByRole("option", { name: "Spring 2026 residency" });
    fireEvent.change(select, { target: { value: endedId } });
    fireEvent.click(screen.getByRole("button", { name: "Download archive (required)" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Download archive again" })).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText(/to confirm/), {
      target: { value: "Spring 2026 residency" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete installation" }));

    expect(await screen.findByText("The confirmation name did not match.")).toBeTruthy();
  });
});
