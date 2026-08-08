import { describe, expect, it } from "vitest";
import { normalizeTranslationText } from "../src/lib/translation-text.js";

describe("normalizeTranslationText", () => {
  it("unwraps a JSON message envelope", () => {
    expect(
      normalizeTranslationText(`{
        "message": "I'm leaving a message. This is a test."
      }`),
    ).toBe("I'm leaving a message. This is a test.");
  });

  it("unwraps fenced and provider-specific translation envelopes", () => {
    expect(normalizeTranslationText('```json\n{"translated_text":"Hello"}\n```')).toBe("Hello");
    expect(normalizeTranslationText('{"translatedText":"Hello"}')).toBe("Hello");
    expect(normalizeTranslationText('{"text":"Hello"}')).toBe("Hello");
  });

  it("preserves plain text and unrecognized JSON", () => {
    expect(normalizeTranslationText("  Hello there.  ")).toBe("Hello there.");
    expect(normalizeTranslationText('{"answer":"Hello"}')).toBe('{"answer":"Hello"}');
  });
});
