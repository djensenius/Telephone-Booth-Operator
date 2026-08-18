import { describe, expect, it } from "vite-plus/test";
import { apiQueryKeys } from "./api-client.js";

describe("apiQueryKeys", () => {
  it("keeps fleet and booth system-current caches disjoint", () => {
    expect(apiQueryKeys.systemAll).toEqual(["system", "current", "all"]);
    expect(apiQueryKeys.system("all")).toEqual(["system", "current", "booth", "all"]);
    expect(apiQueryKeys.systemAll).not.toEqual(apiQueryKeys.system("all"));
  });
});
