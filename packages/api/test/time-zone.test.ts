import { describe, expect, it } from "vite-plus/test";
import { isValidTimeZone, startOfDayInTimeZone } from "../src/lib/time-zone.js";

describe("time-zone helpers", () => {
  it("resolves Toronto midnight across daylight-saving offsets", () => {
    expect(
      startOfDayInTimeZone(new Date("2026-08-08T19:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-08-08T04:00:00.000Z");
    expect(
      startOfDayInTimeZone(new Date("2026-01-08T19:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-01-08T05:00:00.000Z");
  });

  it("rejects unknown IANA zones", () => {
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("Telephone/Booth")).toBe(false);
  });
});
