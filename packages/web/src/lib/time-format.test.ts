import { describe, expect, it } from "vite-plus/test";
import { absoluteTime, durationLabel, relativeTime } from "./time-format.js";

const now = Date.parse("2026-01-02T12:00:00.000Z");

describe("relativeTime", () => {
  it("reports sub-minute gaps as just now", () => {
    expect(relativeTime("2026-01-02T11:59:30.000Z", now)).toBe("just now");
  });

  it("scales through minutes, hours, days and weeks", () => {
    expect(relativeTime("2026-01-02T11:55:00.000Z", now)).toContain("5");
    expect(relativeTime("2026-01-02T09:00:00.000Z", now)).toContain("3");
    expect(relativeTime("2025-12-31T12:00:00.000Z", now)).toContain("2");
    expect(relativeTime("2025-12-05T12:00:00.000Z", now)).toContain("4");
  });

  it("returns null for missing or unparseable values", () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime(undefined, now)).toBeNull();
    expect(relativeTime("not a date", now)).toBeNull();
  });
});

describe("absoluteTime", () => {
  it("returns null for missing values", () => {
    expect(absoluteTime(null)).toBeNull();
    expect(absoluteTime("nope")).toBeNull();
  });

  it("formats a real timestamp", () => {
    expect(absoluteTime("2026-01-02T12:00:00.000Z")).toBeTruthy();
  });
});

describe("durationLabel", () => {
  it("formats seconds and minutes", () => {
    expect(durationLabel(9000)).toBe("9s");
    expect(durationLabel(64_000)).toBe("1m 04s");
    expect(durationLabel(null)).toBeNull();
  });
});
