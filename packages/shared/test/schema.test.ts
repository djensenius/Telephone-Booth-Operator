import { describe, expect, it } from "vite-plus/test";
import { BoothStatusSchema } from "../src/index.js";

describe("BoothStatusSchema", () => {
  it("accepts a valid status", () => {
    const parsed = BoothStatusSchema.parse({
      state: "idle",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.state).toBe("idle");
  });

  it("rejects an unknown state", () => {
    expect(() =>
      BoothStatusSchema.parse({
        state: "nope",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
