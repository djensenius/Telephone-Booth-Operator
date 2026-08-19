import { describe, expect, it } from "vite-plus/test";
import { apiQueryKeys } from "./api-client.js";

describe("apiQueryKeys", () => {
  it("keeps fleet and booth system-current caches disjoint", () => {
    expect(apiQueryKeys.systemAll).toEqual(["system", "current", "all"]);
    expect(apiQueryKeys.system("all")).toEqual(["system", "current", "booth", "all"]);
    expect(apiQueryKeys.systemAll).not.toEqual(apiQueryKeys.system("all"));
  });

  it("keys stats summaries by installation scope and time zone", () => {
    expect(
      apiQueryKeys.statsSummary("11111111-1111-4111-8111-111111111111", "America/Toronto"),
    ).toEqual(["stats", "summary", "11111111-1111-4111-8111-111111111111", "America/Toronto"]);
    expect(apiQueryKeys.statsSummary(undefined, "UTC")).not.toEqual(
      apiQueryKeys.statsSummary(undefined, "America/Toronto"),
    );
  });
});
