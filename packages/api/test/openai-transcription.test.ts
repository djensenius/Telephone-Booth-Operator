import { describe, expect, it, vi } from "vite-plus/test";
import { OpenAiTranscriptionProvider } from "../src/lib/ai/openai-transcription.js";
import { ProviderError } from "../src/lib/ai/types.js";

const fakeFetch = (audioSize: number, contentLength?: number) =>
  vi.fn(async (url: string) => {
    if (url.includes("storage.example")) {
      const buf = new ArrayBuffer(audioSize);
      return new Response(buf, {
        status: 200,
        headers: {
          "content-type": "audio/flac",
          "content-length": String(contentLength ?? audioSize),
        },
      });
    }
    return new Response(JSON.stringify({ text: "hello", language: "en" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

describe("OpenAiTranscriptionProvider", () => {
  it("rejects audio when content-length exceeds maxAudioBytes", async () => {
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "whisper-1",
      maxAudioBytes: 1000,
      fetchImpl: fakeFetch(2000) as unknown as typeof fetch,
    });

    await expect(
      provider.transcribe({
        audioUrl: "https://storage.example/messages/aa/test.flac?sp=r",
        sha256: "a".repeat(64),
        durationMs: 3000,
      }),
    ).rejects.toThrow(ProviderError);

    await expect(
      provider.transcribe({
        audioUrl: "https://storage.example/messages/aa/test.flac?sp=r",
        sha256: "a".repeat(64),
        durationMs: 3000,
      }),
    ).rejects.toThrow(/audio_too_large/);
  });

  it("transcribes successfully when audio is within size limits", async () => {
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      model: "whisper-1",
      maxAudioBytes: 5000,
      fetchImpl: fakeFetch(500) as unknown as typeof fetch,
    });

    const result = await provider.transcribe({
      audioUrl: "https://storage.example/messages/aa/test.flac?sp=r",
      sha256: "a".repeat(64),
      durationMs: 3000,
    });

    expect(result.text).toBe("hello");
    expect(result.language).toBe("en");
  });
});
