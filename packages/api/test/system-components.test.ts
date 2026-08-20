import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  TELEMETRY_HISTORY_MAX_SERIES,
  TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES,
  type ApiTokenScope,
} from "@telephone-booth-operator/shared";

const tokenState = vi.hoisted(() => ({
  telemetrySourceId: "",
  authorization: ["Bearer", "telemetry-token"].join(" "),
}));

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);
vi.mock("../src/lib/require-api-token.js", () => ({
  requireApiToken:
    (requiredScope: ApiTokenScope | readonly ApiTokenScope[] = "operator") =>
    async (
      c: {
        req: { header: (name: string) => string | undefined };
        set: (key: string, value: unknown) => void;
        json: (body: unknown, status?: number) => Response;
      },
      next: () => Promise<void>,
    ) => {
      const authorization = c.req.header("authorization");
      if (!authorization) return c.json({ error: "invalid_token" }, 401);
      const scope = authorization === "Bearer telemetry-token" ? "telemetry" : "operator";
      const tokenScope: ApiTokenScope = authorization.endsWith("monitor-token") ? "monitor" : scope;
      c.set("apiToken", {
        id: "11111111-1111-4111-8111-111111111111",
        name: "router",
        scope: tokenScope,
        telemetrySourceId: tokenScope === "telemetry" ? tokenState.telemetrySourceId : null,
      });
      c.set("apiTokenId", "11111111-1111-4111-8111-111111111111");
      const scopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
      if (!scopes.includes(tokenScope)) return c.json({ error: "insufficient_scope" }, 403);
      await next();
    },
}));

import { createApp } from "../src/index.js";
import {
  buildRouterTelemetrySelector,
  GRAFANA_HISTORY_MAX_RESPONSE_BYTES,
} from "../src/lib/grafana-prometheus.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { COMPONENT_TELEMETRY_MAX_REQUEST_BYTES } from "../src/routes/system-components.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import {
  resetFakeDb,
  seedTelemetrySource,
  store,
  type FakeTelemetrySource,
} from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const fetchMock = vi.fn<typeof fetch>();

const setup = (): FakeTelemetrySource => {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.GRAFANA_URL;
  delete process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  delete process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID;
  resetSessionCryptoForTests();
  resetFakeDb();
  resetFakeAzure();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const source = seedTelemetrySource();
  tokenState.telemetrySourceId = source.id;
  return source;
};

const snapshot = {
  battery: {
    present: true,
    chargePercent: 82,
    temperatureCelsius: 30.5,
    voltageVolts: 7.9,
    currentAmperes: -0.75,
    health: "Good",
    technology: "Li-ion",
    cycleCount: 12,
    chargeCount: 147,
    abnormal: false,
    abnormalType: 0,
  },
  charger: {
    present: true,
    online: true,
    status: "Charging",
    fastCharge: false,
    chargingStatus: 1,
  },
  thermalZones: [{ name: "soc", temperatureCelsius: 51.25 }],
  futureTelemetry: { supported: true },
};

const snapshotWithChargePercent = (chargePercent: number) => ({
  ...snapshot,
  battery: { ...snapshot.battery, chargePercent },
});

describe("component telemetry routes", () => {
  beforeEach(setup);

  it("escapes exact Prometheus label values", () => {
    const selector = buildRouterTelemetrySelector('job"\\\n', "instance");
    expect(selector).toContain('job="job\\"\\\\\\n"');
    expect(selector).not.toContain("\n");
  });

  it("requires a bound telemetry token and persists current data by that binding", async () => {
    const app = createApp();
    const denied = await app.request("/v1/system/components/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capturedAt: "2026-08-18T00:00:00Z", snapshot }),
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({ error: "invalid_token" });

    const wrongScope = await app.request("/v1/system/components/current", {
      method: "PUT",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ capturedAt: "2026-08-18T00:00:00Z", snapshot }),
    });
    expect(wrongScope.status).toBe(403);

    const callerSelectedIdentity = await app.request("/v1/system/components/current", {
      method: "PUT",
      headers: {
        authorization: "Bearer telemetry-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        boothId: "other-booth",
        componentId: "other-router",
        capturedAt: "2026-08-18T00:00:00Z",
        snapshot,
      }),
    });
    expect(callerSelectedIdentity.status).toBe(400);

    const accepted = await app.request("/v1/system/components/current", {
      method: "PUT",
      headers: {
        authorization: "Bearer telemetry-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ capturedAt: "2026-08-18T00:00:00Z", snapshot }),
    });
    expect(accepted.status, await accepted.clone().text()).toBe(204);

    const persisted = store.telemetrySources.get(tokenState.telemetrySourceId);
    expect(persisted?.boothId).toBe("booth-01");
    expect(persisted?.componentId).toBe("router-01");
    expect(persisted?.latestSnapshot).toEqual(snapshot);
    expect(persisted?.capturedAt?.toISOString()).toBe("2026-08-18T00:00:00.000Z");
    expect(persisted?.receivedAt).toBeInstanceOf(Date);
  });

  it("keeps current snapshots monotonic for stale, equal, and newer captures", async () => {
    const source = store.telemetrySources.get(tokenState.telemetrySourceId)!;
    const originalSnapshot = snapshotWithChargePercent(80);
    source.latestSnapshot = originalSnapshot;
    source.capturedAt = new Date("2026-08-18T00:01:00Z");
    source.receivedAt = new Date("2026-08-18T00:01:01Z");
    const originalReceivedAt = source.receivedAt.toISOString();
    const app = createApp();
    const putCurrent = (capturedAt: string, nextSnapshot: typeof snapshot) =>
      app.request("/v1/system/components/current", {
        method: "PUT",
        headers: {
          authorization: tokenState.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ capturedAt, snapshot: nextSnapshot }),
      });

    const stale = await putCurrent("2026-08-18T00:00:00Z", snapshotWithChargePercent(79));
    expect(stale.status, await stale.clone().text()).toBe(204);
    let persisted = store.telemetrySources.get(source.id)!;
    expect(persisted.latestSnapshot).toEqual(originalSnapshot);
    expect(persisted.capturedAt?.toISOString()).toBe("2026-08-18T00:01:00.000Z");
    expect(persisted.receivedAt?.toISOString()).toBe(originalReceivedAt);

    const equalSnapshot = snapshotWithChargePercent(81);
    const equal = await putCurrent("2026-08-18T00:01:00Z", equalSnapshot);
    expect(equal.status, await equal.clone().text()).toBe(204);
    persisted = store.telemetrySources.get(source.id)!;
    expect(persisted.latestSnapshot).toEqual(equalSnapshot);
    expect(persisted.capturedAt?.toISOString()).toBe("2026-08-18T00:01:00.000Z");

    const newerSnapshot = snapshotWithChargePercent(82);
    const newer = await putCurrent("2026-08-18T00:02:00Z", newerSnapshot);
    expect(newer.status, await newer.clone().text()).toBe(204);
    persisted = store.telemetrySources.get(source.id)!;
    expect(persisted.latestSnapshot).toEqual(newerSnapshot);
    expect(persisted.capturedAt?.toISOString()).toBe("2026-08-18T00:02:00.000Z");
  });

  it("returns 403 only when the telemetry source binding is missing", async () => {
    tokenState.telemetrySourceId = "00000000-0000-4000-8000-000000000404";
    const response = await createApp().request("/v1/system/components/current", {
      method: "PUT",
      headers: {
        authorization: tokenState.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ capturedAt: "2026-08-18T00:00:00Z", snapshot }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "telemetry_source_not_bound",
    });
  });

  it("rejects oversized snapshot bodies before JSON parsing", async () => {
    const oversizedBody = JSON.stringify({
      capturedAt: "2026-08-18T00:00:00Z",
      snapshot: {
        ...snapshot,
        futureTelemetry: "x".repeat(COMPONENT_TELEMETRY_MAX_REQUEST_BYTES),
      },
    });
    expect(Buffer.byteLength(oversizedBody)).toBeGreaterThan(COMPONENT_TELEMETRY_MAX_REQUEST_BYTES);

    const response = await createApp().request("/v1/system/components/current", {
      method: "PUT",
      headers: {
        authorization: tokenState.authorization,
        "content-type": "application/json",
      },
      body: oversizedBody,
    });
    expect(response.status, await response.clone().text()).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "payload_too_large",
      limitBytes: COMPONENT_TELEMETRY_MAX_REQUEST_BYTES,
    });
    expect(store.telemetrySources.get(tokenState.telemetrySourceId)?.latestSnapshot).toBeNull();
  });

  it("lists and filters current sources for operators and monitors", async () => {
    const source = store.telemetrySources.get(tokenState.telemetrySourceId)!;
    source.latestSnapshot = snapshot;
    source.capturedAt = new Date("2026-08-18T00:00:00Z");
    source.receivedAt = new Date("2026-08-18T00:00:01Z");
    const app = createApp();

    const denied = await app.request("/v1/system/components/current");
    expect(denied.status).toBe(401);

    const cookie = operatorCookie();
    const current = await app.request(
      "/v1/system/components/current?boothId=booth-01&componentId=router-01",
      { headers: { cookie } },
    );
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject([
      {
        id: source.id,
        boothId: "booth-01",
        componentId: "router-01",
        latestSnapshot: snapshot,
        capturedAt: "2026-08-18T00:00:00.000Z",
        receivedAt: "2026-08-18T00:00:01.000Z",
      },
    ]);

    const monitor = await app.request(
      "/v1/system/components/current?boothId=booth-01&componentId=router-01",
      {
        headers: {
          authorization: ["Bearer", "monitor-token"].join(" "),
        },
      },
    );
    expect(monitor.status).toBe(200);
    await expect(monitor.json()).resolves.toMatchObject([
      {
        boothId: "booth-01",
        componentId: "router-01",
        latestSnapshot: snapshot,
      },
    ]);

    const empty = await app.request(
      "/v1/system/components/current?boothId=booth-01&componentId=missing",
      { headers: { cookie } },
    );
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual([]);
  });

  it("returns 503 when Grafana history configuration is missing", async () => {
    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "telemetry_history_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send Grafana credentials to a cleartext URL", async () => {
    process.env.GRAFANA_URL = "http://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "telemetry_history_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the Grafana datasource proxy with the internal metric allowlist", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com/observability";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: {
                  __name__: "glinet_battery_current_amperes",
                  job: "glinet-router",
                  instance: "router-01",
                },
                values: [
                  [1_776_643_200, "-0.75"],
                  [1_776_643_260, "-0.50"],
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-04-20T00%3A00%3A00Z&to=2026-04-20T00%3A01%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: { boothId: "booth-01", componentId: "router-01" },
      stepSeconds: 60,
      series: [
        {
          metric: "glinet_battery_current_amperes",
          labels: { job: "glinet-router", instance: "router-01" },
          points: [
            { timestamp: 1_776_643_200, value: -0.75 },
            { timestamp: 1_776_643_260, value: -0.5 },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe(
      "/observability/api/datasources/proxy/uid/prom-main/api/v1/query_range",
    );
    expect(url.searchParams.get("query")).toContain('__name__=~"^(glinet_battery_charge_percent|');
    expect(url.searchParams.get("query")).toContain("glinet_battery_charge_count");
    expect(url.searchParams.get("query")).toContain("glinet_battery_abnormal_type");
    expect(url.searchParams.get("query")).toContain('job="glinet-router"');
    expect(url.searchParams.get("query")).toContain('instance="router-01"');
    expect(requestInit?.headers).toMatchObject({
      authorization: "Bearer test-service-token",
    });
  });

  it("rejects excessive ranges and point counts before querying Grafana", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    const cookie = operatorCookie();
    const app = createApp();

    const excessiveRange = await app.request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-01-01T00%3A00%3A00Z&to=2026-02-02T00%3A00%3A00Z",
      { headers: { cookie } },
    );
    expect(excessiveRange.status).toBe(400);

    const excessivePoints = await app.request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-01-01T00%3A00%3A00Z&to=2026-01-03T00%3A00%3A00Z&stepSeconds=15",
      { headers: { cookie } },
    );
    expect(excessivePoints.status).toBe(400);

    const shortStep = await app.request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-01-01T00%3A00%3A00Z&to=2026-01-01T01%3A00%3A00Z&stepSeconds=14",
      { headers: { cookie } },
    );
    expect(shortStep.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 for a nonconforming Grafana response", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: { resultType: "vector" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
  });

  it("returns 502 when Grafana rejects the datasource request", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns 502 before buffering a Grafana response above the byte limit", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    let remainingBytes = GRAFANA_HISTORY_MAX_RESPONSE_BYTES + 1;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (remainingBytes === 0) {
              controller.close();
              return;
            }
            const bytes = Math.min(remainingBytes, chunk.byteLength);
            controller.enqueue(chunk.subarray(0, bytes));
            remainingBytes -= bytes;
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
  });

  it("returns 502 when Grafana returns too many series", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: Array.from({ length: TELEMETRY_HISTORY_MAX_SERIES + 1 }, (_, index) => ({
              metric: {
                __name__: "glinet_thermal_temperature_celsius",
                zone: `zone-${index}`,
              },
              values: [[1_776_643_200, "50"]],
            })),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
  });

  it("returns 502 when Grafana returns too many total samples", async () => {
    process.env.GRAFANA_URL = "https://grafana.example.com";
    process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
    process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
    const seriesCount = 11;
    const samplesPerSeries = Math.floor(TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES / seriesCount) + 1;
    const payload = JSON.stringify({
      status: "success",
      data: {
        resultType: "matrix",
        result: Array.from({ length: seriesCount }, (_, seriesIndex) => ({
          metric: {
            __name__: "glinet_thermal_temperature_celsius",
            zone: `zone-${seriesIndex}`,
          },
          values: Array.from({ length: samplesPerSeries }, (_, sampleIndex) => [sampleIndex, "50"]),
        })),
      },
    });
    expect(Buffer.byteLength(payload)).toBeLessThan(GRAFANA_HISTORY_MAX_RESPONSE_BYTES);
    fetchMock.mockResolvedValue(
      new Response(payload, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const response = await createApp().request(
      "/v1/system/components/history?boothId=booth-01&componentId=router-01&from=2026-08-17T00%3A00%3A00Z&to=2026-08-18T00%3A00%3A00Z",
      { headers: { cookie: operatorCookie() } },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
  });
});
