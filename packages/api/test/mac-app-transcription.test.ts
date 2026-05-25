import { describe, expect, it } from "vite-plus/test";
import { MacAppTranscriptionProvider } from "../src/lib/ai/mac-app-transcription.js";

const headerValue = (headers: HeadersInit | undefined, name: string): string | null =>
  new Headers(headers).get(name);

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MacAppTranscriptionProvider", () => {
  it("downloads SAS audio and posts multipart to the OpenAI-compatible endpoint", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]).buffer;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://blob.example/audio.flac?sig=test") {
        return new Response(audio, {
          status: 200,
          headers: { "content-length": String(audio.byteLength), "content-type": "audio/flac" },
        });
      }
      return jsonResponse({ text: "bonjour", language: "fr" });
    };
    const provider = new MacAppTranscriptionProvider({
      url: "http://127.0.0.1:8089",
      token: "local-token",
      model: "whisper-local",
      maxAudioBytes: 1024,
      fetchImpl: fakeFetch,
    });

    const result = await provider.transcribe({
      audioUrl: "https://blob.example/audio.flac?sig=test",
      sha256: "a".repeat(64),
      durationMs: 1234,
    });

    expect(result).toEqual({ text: "bonjour", language: "fr" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://blob.example/audio.flac?sig=test");
    const upload = calls[1];
    expect(upload?.url).toBe("http://127.0.0.1:8089/v1/audio/transcriptions");
    expect(headerValue(upload?.init?.headers, "authorization")).toBe("Bearer local-token");
    expect(upload?.init?.body).toBeInstanceOf(FormData);
    const form = upload?.init?.body instanceof FormData ? upload.init.body : undefined;
    expect(form?.get("model")).toBe("whisper-local");
    expect(form?.get("response_format")).toBe("verbose_json");
    expect(form?.get("file")).toBeInstanceOf(Blob);
  });

  it("accepts a full transcription URL and omits Authorization when token is absent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://blob.example/audio.flac")
        return new Response(new ArrayBuffer(4));
      return jsonResponse({ text: "hello" });
    };
    const provider = new MacAppTranscriptionProvider({
      url: "http://127.0.0.1:8089/v1/audio/transcriptions",
      token: null,
      maxAudioBytes: 1024,
      fetchImpl: fakeFetch,
    });

    await expect(
      provider.transcribe({
        audioUrl: "https://blob.example/audio.flac",
        sha256: "b".repeat(64),
        durationMs: null,
      }),
    ).resolves.toEqual({ text: "hello", language: null });

    const upload = calls[1];
    expect(upload?.url).toBe("http://127.0.0.1:8089/v1/audio/transcriptions");
    expect(headerValue(upload?.init?.headers, "authorization")).toBeNull();
  });

  it("cancels the audio response body when the SAS fetch fails", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const fakeFetch: typeof fetch = async () =>
      new Response(body, {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    const provider = new MacAppTranscriptionProvider({
      url: "http://127.0.0.1:8089",
      token: null,
      maxAudioBytes: 1024,
      fetchImpl: fakeFetch,
    });

    await expect(
      provider.transcribe({
        audioUrl: "https://blob.example/expired.flac",
        sha256: "d".repeat(64),
        durationMs: 3000,
      }),
    ).rejects.toMatchObject({ provider: "mac_app", errorCode: "audio_fetch_failed", status: 403 });

    expect(canceled).toBe(true);
  });

  it("rejects by content-length before buffering oversized audio", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      },
    });
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(body, {
        status: 200,
        headers: { "content-length": "2048", "content-type": "audio/flac" },
      });
    };
    const provider = new MacAppTranscriptionProvider({
      url: "http://127.0.0.1:8089",
      token: null,
      maxAudioBytes: 1024,
      fetchImpl: fakeFetch,
    });

    await expect(
      provider.transcribe({
        audioUrl: "https://blob.example/big.flac",
        sha256: "c".repeat(64),
        durationMs: 3000,
      }),
    ).rejects.toMatchObject({ provider: "mac_app", errorCode: "audio_too_large" });

    expect(calls).toEqual(["https://blob.example/big.flac"]);
    expect(canceled).toBe(true);
  });
});
