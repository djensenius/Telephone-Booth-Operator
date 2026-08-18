import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { buildThermalHistoryQuery } from "../src/lib/grafana-prometheus.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb, seedTelemetrySource } from "./support/fake-db.js";
import { operatorCookie } from "./support/http.js";

const fetchMock = vi.fn<typeof fetch>();

const setup = (): void => {
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
};

const configureGrafana = (): void => {
  process.env.GRAFANA_URL = "https://grafana.example.com/observability";
  process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "test-service-token";
  process.env.GRAFANA_PROMETHEUS_DATASOURCE_UID = "prom-main";
};

const historyPath = (
  overrides: {
    readonly boothId?: string;
    readonly componentId?: string;
    readonly from?: string;
    readonly to?: string;
    readonly stepSeconds?: number;
  } = {},
): string => {
  const search = new URLSearchParams({
    boothId: overrides.boothId ?? "booth-01",
    from: overrides.from ?? "2026-08-17T00:00:00Z",
    to: overrides.to ?? "2026-08-18T00:00:00Z",
  });
  if (overrides.componentId) search.set("componentId", overrides.componentId);
  if (overrides.stepSeconds) search.set("stepSeconds", String(overrides.stepSeconds));
  return `/v1/system/thermals/history?${search.toString()}`;
};

describe("system thermal history", () => {
  beforeEach(setup);

  it("requires operator authentication", async () => {
    seedTelemetrySource({ componentId: "router" });
    const response = await createApp().request(historyPath());
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers componentId=router and sends exactly the fixed thermal PromQL", async () => {
    seedTelemetrySource({
      componentId: "aaa-router",
      displayName: "Alphabetical router",
      prometheusJob: "wrong-job",
      prometheusInstance: "wrong-instance",
    });
    const preferred = seedTelemetrySource({
      componentId: "router",
      displayName: "Preferred router",
      prometheusJob: 'glinet"job',
      prometheusInstance: "router\\instance",
    });
    configureGrafana();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: {
                  __name__: "booth_cpu_temperature_celsius",
                  booth_id: "booth-01",
                  job: "booth",
                },
                values: [[1_776_643_200, "48.5"]],
              },
              {
                metric: {
                  __name__: "glinet_battery_temperature_celsius",
                  job: 'glinet"job',
                  instance: "router\\instance",
                },
                values: [[1_776_643_200, "31.25"]],
              },
              {
                metric: {
                  __name__: "glinet_thermal_temperature_celsius",
                  job: 'glinet"job',
                  instance: "router\\instance",
                  zone: "soc",
                },
                values: [[1_776_643_200, "54.75"]],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await createApp().request(historyPath(), {
      headers: { cookie: operatorCookie() },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      boothId: "booth-01",
      source: {
        boothId: preferred.boothId,
        componentId: preferred.componentId,
        displayName: preferred.displayName,
        kind: preferred.kind,
        prometheusJob: preferred.prometheusJob,
        prometheusInstance: preferred.prometheusInstance,
      },
      from: "2026-08-17T00:00:00.000Z",
      to: "2026-08-18T00:00:00.000Z",
      stepSeconds: 60,
      series: [
        {
          metric: "booth_cpu_temperature_celsius",
          labels: { booth_id: "booth-01", job: "booth" },
          points: [{ timestamp: 1_776_643_200, value: 48.5 }],
        },
        {
          metric: "glinet_battery_temperature_celsius",
          labels: { job: 'glinet"job', instance: "router\\instance" },
          points: [{ timestamp: 1_776_643_200, value: 31.25 }],
        },
        {
          metric: "glinet_thermal_temperature_celsius",
          labels: { job: 'glinet"job', instance: "router\\instance", zone: "soc" },
          points: [{ timestamp: 1_776_643_200, value: 54.75 }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe(
      "/observability/api/datasources/proxy/uid/prom-main/api/v1/query_range",
    );
    expect(url.searchParams.get("query")).toBe(
      buildThermalHistoryQuery("booth-01", preferred.prometheusJob, preferred.prometheusInstance),
    );
  });

  it("accepts an exact componentId and otherwise falls back deterministically", async () => {
    const alpha = seedTelemetrySource({
      componentId: "alpha",
      displayName: "Alpha router",
      prometheusJob: "alpha-job",
      prometheusInstance: "alpha-instance",
    });
    const beta = seedTelemetrySource({
      componentId: "beta",
      displayName: "Beta router",
      prometheusJob: "beta-job",
      prometheusInstance: "beta-instance",
    });
    configureGrafana();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "matrix", result: [] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const app = createApp();
    const cookie = operatorCookie();

    const selected = await app.request(historyPath({ componentId: beta.componentId }), {
      headers: { cookie },
    });
    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toMatchObject({
      source: { componentId: beta.componentId },
    });

    const fallback = await app.request(historyPath(), { headers: { cookie } });
    expect(fallback.status).toBe(200);
    await expect(fallback.json()).resolves.toMatchObject({
      source: { componentId: alpha.componentId },
    });
  });

  it("enforces range bounds and reports missing sources before calling Grafana", async () => {
    configureGrafana();
    const app = createApp();
    const cookie = operatorCookie();

    const missing = await app.request(historyPath(), { headers: { cookie } });
    expect(missing.status).toBe(404);

    seedTelemetrySource({ componentId: "router" });
    const excessiveRange = await app.request(
      historyPath({
        from: "2026-01-01T00:00:00Z",
        to: "2026-02-02T00:00:00Z",
      }),
      { headers: { cookie } },
    );
    expect(excessiveRange.status).toBe(400);

    const excessivePoints = await app.request(
      historyPath({
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-03T00:00:00Z",
        stepSeconds: 15,
      }),
      { headers: { cookie } },
    );
    expect(excessivePoints.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps missing configuration and non-thermal upstream data to safe errors", async () => {
    seedTelemetrySource({ componentId: "router" });
    const app = createApp();
    const cookie = operatorCookie();

    const unconfigured = await app.request(historyPath(), { headers: { cookie } });
    expect(unconfigured.status).toBe(503);
    await expect(unconfigured.json()).resolves.toEqual({
      error: "telemetry_history_not_configured",
    });

    configureGrafana();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { __name__: "process_temperature_celsius" },
                values: [[1_776_643_200, "40"]],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const invalid = await app.request(historyPath(), { headers: { cookie } });
    expect(invalid.status).toBe(502);
    await expect(invalid.json()).resolves.toEqual({ error: "telemetry_history_upstream" });
  });
});
