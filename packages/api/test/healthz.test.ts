import { describe, expect, it } from "vite-plus/test";
import { app } from "../src/index.js";

describe("healthz", () => {
  it("returns ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
