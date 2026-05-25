import { describe, expect, it, vi } from "vite-plus/test";
import { OpenAiModerationProvider } from "../src/lib/ai/openai-moderation.js";
import { OpenAiTranscriptionProvider } from "../src/lib/ai/openai-transcription.js";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAiTranscriptionProvider", () => {
  it("downloads the audio and posts multipart to /v1/audio/transcriptions", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]).buffer;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://blob/audio.flac") {
        return new Response(audio, { status: 200 });
      }
      return jsonResponse({ text: "hello world", language: "en" });
    };
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/",
      model: "whisper-1",
      fetchImpl: fakeFetch,
    });

    const result = await provider.transcribe({
      audioUrl: "https://blob/audio.flac",
      sha256: "a".repeat(64),
      durationMs: 1234,
    });

    expect(result).toEqual({ text: "hello world", language: "en" });
    expect(calls).toHaveLength(2);
    const upload = calls[1];
    expect(upload?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((upload?.init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(upload?.init?.body).toBeInstanceOf(FormData);
  });

  it("throws ProviderError when transcription request fails", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      if (String(url) === "https://blob/audio.flac") return new Response(new ArrayBuffer(4));
      return new Response("nope", { status: 500 });
    };
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "whisper-1",
      fetchImpl: fakeFetch,
    });
    await expect(
      provider.transcribe({
        audioUrl: "https://blob/audio.flac",
        sha256: "x".repeat(64),
        durationMs: null,
      }),
    ).rejects.toMatchObject({ provider: "openai" });
  });
});

describe("OpenAiModerationProvider", () => {
  it("maps a clean response to recommendation 'approve'", async () => {
    const fakeFetch: typeof fetch = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            flagged: false,
            categories: { hate: false, violence: false },
            category_scores: { hate: 0.01, violence: 0.05 },
          },
        ],
      }),
    );
    const provider = new OpenAiModerationProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "omni-moderation-latest",
      fetchImpl: fakeFetch,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
    });
    const result = await provider.moderate({ text: "hello" });
    expect(result.recommendation).toBe("approve");
    expect(result.flagged).toBe(false);
    expect(result.maxScore).toBeCloseTo(0.05);
  });

  it("maps a flagged response to recommendation 'reject'", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        results: [{ flagged: true, categories: { hate: true }, category_scores: { hate: 0.92 } }],
      });
    const provider = new OpenAiModerationProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "omni-moderation-latest",
      fetchImpl: fakeFetch,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
    });
    const result = await provider.moderate({ text: "bad" });
    expect(result.recommendation).toBe("reject");
    expect(result.reasonSummary).toBe("hate");
  });

  it("maps a borderline response to recommendation 'review'", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse({
        results: [{ flagged: false, categories: { hate: false }, category_scores: { hate: 0.4 } }],
      });
    const provider = new OpenAiModerationProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "omni-moderation-latest",
      fetchImpl: fakeFetch,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
    });
    const result = await provider.moderate({ text: "meh" });
    expect(result.recommendation).toBe("review");
  });

  it("throws ProviderError when the API responds with an error status", async () => {
    const fakeFetch: typeof fetch = async () => new Response("rate limited", { status: 429 });
    const provider = new OpenAiModerationProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "omni-moderation-latest",
      fetchImpl: fakeFetch,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
    });
    await expect(provider.moderate({ text: "hello" })).rejects.toMatchObject({
      provider: "openai",
      status: 429,
    });
  });
});
