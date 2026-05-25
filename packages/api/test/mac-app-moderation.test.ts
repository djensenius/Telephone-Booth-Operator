import { describe, expect, it } from "vite-plus/test";
import { MacAppModerationProvider } from "../src/lib/ai/mac-app-moderation.js";
import { ProviderError } from "../src/lib/ai/types.js";

const headerValue = (headers: HeadersInit | undefined, name: string): string | null =>
  new Headers(headers).get(name);

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MacAppModerationProvider", () => {
  it("posts OpenAI-shaped JSON and maps the OpenAI moderation response", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: "modr-local-test",
        model: "omni-moderation-latest",
        results: [
          {
            flagged: true,
            categories: { hate: true, violence: false },
            category_scores: { hate: 0.92, violence: 0.03 },
          },
        ],
      });
    };
    const provider = new MacAppModerationProvider({
      url: "http://127.0.0.1:8089",
      token: "local-token",
      model: "omni-moderation-latest",
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
      fetchImpl: fakeFetch,
    });

    const result = await provider.moderate({ text: "bad text" });

    expect(result).toEqual({
      flagged: true,
      recommendation: "reject",
      maxScore: 0.92,
      categories: { hate: 0.92, violence: 0.03 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8089/v1/moderations");
    expect(headerValue(calls[0]?.init?.headers, "authorization")).toBe("Bearer local-token");
    expect(headerValue(calls[0]?.init?.headers, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "omni-moderation-latest",
      input: "bad text",
    });
  });

  it("omits Authorization and derives approve for clean content", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        results: [
          {
            flagged: false,
            categories: { hate: false, violence: false },
            category_scores: { hate: 0.01, violence: 0.05 },
          },
        ],
      });
    };
    const provider = new MacAppModerationProvider({
      url: "http://127.0.0.1:8089/v1/moderations",
      token: null,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
      fetchImpl: fakeFetch,
    });

    const result = await provider.moderate({ text: "hello" });

    expect(result.recommendation).toBe("approve");
    expect(result.flagged).toBe(false);
    expect(result.maxScore).toBeCloseTo(0.05);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8089/v1/moderations");
    expect(headerValue(calls[0]?.init?.headers, "authorization")).toBeNull();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ input: "hello" });
  });

  it("surfaces upstream HTTP errors as ProviderError", async () => {
    const fakeFetch: typeof fetch = async () => new Response("nope", { status: 503 });
    const provider = new MacAppModerationProvider({
      url: "http://127.0.0.1:8089",
      token: null,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
      fetchImpl: fakeFetch,
    });

    await expect(provider.moderate({ text: "hello" })).rejects.toMatchObject({
      provider: "mac_app",
      errorCode: "moderation_failed",
      status: 503,
    });
  });

  it("surfaces network failures as ProviderError", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new TypeError("connection refused");
    };
    const provider = new MacAppModerationProvider({
      url: "http://127.0.0.1:8089",
      token: null,
      rejectThreshold: 0.85,
      approveThreshold: 0.15,
      fetchImpl: fakeFetch,
    });

    await expect(provider.moderate({ text: "hello" })).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.moderate({ text: "hello" })).rejects.toMatchObject({
      provider: "mac_app",
      errorCode: "moderation_failed",
    });
  });
});
