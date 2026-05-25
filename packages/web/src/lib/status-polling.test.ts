import { describe, expect, it, vi } from "vite-plus/test";

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
const { useStatusCurrent, useStatusHistory } = await import("./api-client.js");

describe("useStatusCurrent", () => {
  it("polls every 5 s when not paused", () => {
    mockUseQuery.mockClear();
    useStatusCurrent();
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: 5_000 }),
    );
  });

  it("disables polling when paused", () => {
    mockUseQuery.mockClear();
    useStatusCurrent({ paused: true });
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: false }),
    );
  });
});

describe("useStatusHistory", () => {
  it("polls every 5 s when not paused", () => {
    mockUseQuery.mockClear();
    useStatusHistory();
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: 5_000 }),
    );
  });

  it("disables polling when paused", () => {
    mockUseQuery.mockClear();
    useStatusHistory({ paused: true });
    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ refetchInterval: false }),
    );
  });
});
