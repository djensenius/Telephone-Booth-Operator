import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { randomUUID } from "node:crypto";
import { createApp } from "../src/index.js";
import { resetStatsCacheForTests } from "../src/routes/stats.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedCallSession, store } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const setup = () => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  resetStatsCacheForTests();
};

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60 * 1000);
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("GET /v1/stats/overview custom ranges", () => {
  beforeEach(setup);

  it("reports window=custom and honours start/end bounds", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    // One call inside the [3d ago, 1d ago] window, one outside (today).
    seedCallSession({ startedAt: daysAgo(2), endedAt: daysAgo(2), outcome: "recording_completed" });
    seedCallSession({
      startedAt: minutesAgo(5),
      endedAt: minutesAgo(4),
      outcome: "recording_completed",
    });

    const start = daysAgo(3).toISOString();
    const end = daysAgo(1).toISOString();
    const res = await app.request(
      `/v1/stats/overview?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: string; calls: { total: number } };
    expect(body.window).toBe("custom");
    expect(body.calls.total).toBe(1);
  });

  it("treats end=now as the current instant", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    seedCallSession({
      startedAt: minutesAgo(5),
      endedAt: minutesAgo(4),
      outcome: "recording_completed",
    });

    const start = daysAgo(1).toISOString();
    const res = await app.request(`/v1/stats/overview?start=${encodeURIComponent(start)}&end=now`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: string; calls: { total: number } };
    expect(body.window).toBe("custom");
    expect(body.calls.total).toBe(1);
  });

  it("rejects a start after end", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const start = daysAgo(1).toISOString();
    const end = daysAgo(3).toISOString();
    const res = await app.request(
      `/v1/stats/overview?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });
});

describe("Saved metric filters CRUD", () => {
  beforeEach(setup);

  it("requires authentication", async () => {
    const app = createApp();
    const res = await app.request("/v1/stats/filters");
    expect(res.status).toBe(401);
  });

  it("creates, lists, updates and deletes an owner's filter", async () => {
    const app = createApp();
    const cookie = operatorCookie();

    const created = await app.request("/v1/stats/filters", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Last week", window: "7d" }),
    });
    expect(created.status).toBe(201);
    const filter = (await created.json()) as { id: string; name: string; window: string | null };
    expect(filter.name).toBe("Last week");
    expect(filter.window).toBe("7d");

    const list = await app.request("/v1/stats/filters", { headers: { cookie } });
    const listed = (await list.json()) as { items: Array<{ id: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(filter.id);

    const fetched = await app.request(`/v1/stats/filters/${filter.id}`, { headers: { cookie } });
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { id: string; name: string };
    expect(fetchedBody.id).toBe(filter.id);
    expect(fetchedBody.name).toBe("Last week");

    const start = daysAgo(10).toISOString();
    const updated = await app.request(`/v1/stats/filters/${filter.id}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Custom", window: null, start, end: null }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      name: string;
      window: string | null;
      end: string | null;
    };
    expect(updatedBody.name).toBe("Custom");
    expect(updatedBody.window).toBeNull();
    expect(updatedBody.end).toBeNull();

    const removed = await app.request(`/v1/stats/filters/${filter.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);

    const afterList = await app.request("/v1/stats/filters", { headers: { cookie } });
    const afterBody = (await afterList.json()) as { items: unknown[] };
    expect(afterBody.items).toHaveLength(0);
  });

  it("rejects an empty selection", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/filters", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Nothing" }),
    });
    expect(res.status).toBe(400);
  });

  it("saves a custom range that spans the whole history through now", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    // The UI represents "from the beginning through now" as window null with
    // both bounds null; this explicit custom selection must be accepted.
    const res = await app.request("/v1/stats/filters", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "All time", window: null, start: null, end: null }),
    });
    expect(res.status).toBe(201);
    const filter = (await res.json()) as {
      window: string | null;
      start: string | null;
      end: string | null;
    };
    expect(filter.window).toBeNull();
    expect(filter.start).toBeNull();
    expect(filter.end).toBeNull();
  });

  it("rejects a preset window combined with a custom range", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    const res = await app.request("/v1/stats/filters", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Contradiction",
        window: "7d",
        start: daysAgo(3).toISOString(),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("does not expose another operator's filters", async () => {
    const app = createApp();
    const cookie = operatorCookie();
    // Seed a filter owned by a different operator directly.
    const otherId = randomUUID();
    store.metricFilters.set(otherId, {
      id: otherId,
      userId: "operator-2",
      name: "Not mine",
      window: "24h",
      rangeStart: null,
      rangeEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const list = await app.request("/v1/stats/filters", { headers: { cookie } });
    const body = (await list.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);

    const fetch = await app.request(`/v1/stats/filters/${otherId}`, { headers: { cookie } });
    expect(fetch.status).toBe(404);

    const update = await app.request(`/v1/stats/filters/${otherId}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijack", window: "24h" }),
    });
    expect(update.status).toBe(404);

    const del = await app.request(`/v1/stats/filters/${otherId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(404);
  });
});
