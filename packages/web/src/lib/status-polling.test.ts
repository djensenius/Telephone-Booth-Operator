import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// We test that the hook factories pass the correct refetchInterval.
// Rather than rendering the hooks (which require a full QueryClient),
// we mock @tanstack/react-query and inspect the options passed to useQuery.

const mockUseQuery = vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null });
vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]): unknown => mockUseQuery(...args),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

// Must import AFTER mock is registered
const { status, useStatusCurrent, useStatusHistory } = await import("./api-client.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("status.current", () => {
  it("returns null for an explicit synthetic status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            state: "idle",
            updatedAt: "1970-01-01T00:00:00.000Z",
            isSynthetic: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(status.current()).resolves.toBeNull();
  });

  it("keeps real status from an older API that has no synthetic marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 42,
            state: "recording",
            updatedAt: "2026-08-15T16:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(status.current()).resolves.toMatchObject({ id: 42, state: "recording" });
  });
});

describe("useStatusCurrent", () => {
  it("polls every 5 s when not paused", () => {
    mockUseQuery.mockClear();
    useStatusCurrent();
    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: 5_000 }));
  });

  it("disables polling when paused", () => {
    mockUseQuery.mockClear();
    useStatusCurrent({ paused: true });
    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: false }));
  });
});

describe("useStatusHistory", () => {
  it("polls every 5 s when not paused", () => {
    mockUseQuery.mockClear();
    useStatusHistory();
    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: 5_000 }));
  });

  it("disables polling when paused", () => {
    mockUseQuery.mockClear();
    useStatusHistory({ paused: true });
    expect(mockUseQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: false }));
  });
});
