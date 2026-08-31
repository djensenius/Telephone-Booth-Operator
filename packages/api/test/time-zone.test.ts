import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TIME_ZONE,
  IanaTimeZoneSchema,
  isValidTimeZone,
  rangesForDateInTimeZone,
  startOfDateInTimeZone,
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

  it("resolves the first instant when a time-zone transition skips midnight", () => {
    expect(startOfDateInTimeZone("2026-04-24", "Africa/Cairo").toISOString()).toBe(
      "2026-04-23T22:00:00.000Z",
    );
  });

  it("returns every UTC segment when a rollback crosses local midnight", () => {
    const ranges = rangesForDateInTimeZone("2000-10-29", "America/St_Johns");

    expect(ranges.map((range) => range.start.toISOString())).toEqual([
      "2000-10-29T02:30:00.000Z",
      "2000-10-29T03:30:00.000Z",
    ]);
    expect(startOfDateInTimeZone("2000-10-29", "America/St_Johns").toISOString()).toBe(
      "2000-10-29T02:30:00.000Z",
    );
  });

  it("rejects a local calendar date skipped by a time-zone transition", () => {
    expect(() => startOfDateInTimeZone("2011-12-30", "Pacific/Apia")).toThrow("does not exist");
  });

  it("rejects unknown IANA zones", () => {
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("Telephone/Booth")).toBe(false);
    expect(IanaTimeZoneSchema.parse(DEFAULT_TIME_ZONE)).toBe("America/Toronto");
    expect(() => IanaTimeZoneSchema.parse("Telephone/Booth")).toThrow();
  });
});
