import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { invalidateInstallationScopedQueries } from "./api-client.js";

// The `installation` WS envelope (StatusScreen) and the local start/end
// mutations both funnel through this helper. Every scoped read must be
// invalidated so the console re-scopes without a reload.
describe("invalidateInstallationScopedQueries", () => {
  it("invalidates every installation-scoped query family", () => {
    const client = new QueryClient();
    const seed = (key: readonly unknown[]): void => {
      client.setQueryData(key, { items: [] });
    };
    seed(["installations", "list"]);
    seed(["stats", "overview", { kind: "preset", window: "7d" }, null]);
    seed(["stats", "summary", null]);
    seed(["messages", "list", "all", null, 100]);
    seed(["sessions", "list", null, null]);
    seed(["events", "list", { limit: 100 }]);
    seed(["questions", "list", "all", null]);
    seed(["status", "current"]);
    seed(["status", "history"]);

    invalidateInstallationScopedQueries(client);

    const stale = (key: readonly unknown[]): boolean =>
      client.getQueryState(key)?.isInvalidated === true;
    expect(stale(["installations", "list"])).toBe(true);
    expect(stale(["stats", "overview", { kind: "preset", window: "7d" }, null])).toBe(true);
    expect(stale(["stats", "summary", null])).toBe(true);
    expect(stale(["messages", "list", "all", null, 100])).toBe(true);
    expect(stale(["sessions", "list", null, null])).toBe(true);
    expect(stale(["events", "list", { limit: 100 }])).toBe(true);
    expect(stale(["questions", "list", "all", null])).toBe(true);
    expect(stale(["status", "current"])).toBe(true);
    expect(stale(["status", "history"])).toBe(true);
  });
});
