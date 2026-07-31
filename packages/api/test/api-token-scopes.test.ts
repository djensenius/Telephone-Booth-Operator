import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiTokenScope } from "@telephone-booth-operator/shared";
import { phoneHeaders } from "./support/http.js";

const tokenState = vi.hoisted(() => ({ scope: "monitor" as ApiTokenScope }));

vi.mock("../src/lib/api-tokens.js", () => ({
  verifyToken: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    scope: tokenState.scope,
  })),
}));

import { requireApiToken, type ApiTokenVariables } from "../src/lib/require-api-token.js";

const app = new Hono<{ Variables: ApiTokenVariables }>();
app.get("/read", requireApiToken(["operator", "monitor"]), (c) => c.json({ ok: true }));
app.post("/write", requireApiToken(), (c) => c.json({ ok: true }));

describe("API token scopes", () => {
  beforeEach(() => {
    tokenState.scope = "monitor";
  });

  it("allows monitor reads but rejects operator writes", async () => {
    expect((await app.request("/read", { headers: phoneHeaders })).status).toBe(200);
    expect((await app.request("/write", { method: "POST", headers: phoneHeaders })).status).toBe(
      403,
    );
  });

  it("rejects worker tokens from monitor reads", async () => {
    tokenState.scope = "worker";
    expect((await app.request("/read", { headers: phoneHeaders })).status).toBe(403);
  });
});
