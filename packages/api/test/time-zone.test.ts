import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TIME_ZONE,
  IanaTimeZoneSchema,
  isValidTimeZone,
  startOfDayInTimeZone,
} from "../src/lib/time-zone.js";

describe("time-zone helpers", () => {
  it("resolves Toronto midnight across daylight-saving offsets", () => {
    expect(
      startOfDayInTimeZone(new Date("2026-08-08T19:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-08-08T04:00:00.000Z");
    expect(
      startOfDayInTimeZone(new Date("2026-01-08T19:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-01-08T05:00:00.000Z");
    expect(
      startOfDayInTimeZone(new Date("2026-03-08T16:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-03-08T05:00:00.000Z");
    expect(
      startOfDayInTimeZone(new Date("2026-11-01T17:00:00.000Z"), "America/Toronto").toISOString(),
    ).toBe("2026-11-01T04:00:00.000Z");
  });

  it("rejects unknown IANA zones", () => {
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("Telephone/Booth")).toBe(false);
    expect(IanaTimeZoneSchema.parse(DEFAULT_TIME_ZONE)).toBe("America/Toronto");
    expect(() => IanaTimeZoneSchema.parse("Telephone/Booth")).toThrow();
  });
});
