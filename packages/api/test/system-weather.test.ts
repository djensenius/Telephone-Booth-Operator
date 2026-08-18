import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/db.js", async () => ({ db: (await import("./support/fake-db.js")).fakeDb }));
vi.mock(
  "../src/lib/azure-blob.js",
  async () => (await import("./support/fake-azure.js")).fakeAzureModule,
);

import { createApp } from "../src/index.js";
import { buildCurrentWeatherQuery } from "../src/lib/grafana-prometheus.js";
import { resetSessionCryptoForTests } from "../src/lib/session.js";
import { resetFakeAzure } from "./support/fake-azure.js";
import { resetFakeDb } from "./support/fake-db.js";
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

const currentPath = (boothId = "booth-01"): string =>
  `/v1/system/weather/current?${new URLSearchParams({ boothId }).toString()}`;

const observedAt = "2026-08-18T14:30:00.000Z";
const fetchedAt = "2026-08-18T14:31:00.000Z";
const scrapeTimestamp = Date.parse("2026-08-18T14:32:00.000Z") / 1000;

const weatherResponse = (): Response =>
  new Response(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: {
              __name__: "booth_outdoor_weather_temperature_celsius",
              booth_id: "booth-01",
              source: "open_meteo",
            },
            value: [scrapeTimestamp, "22.2"],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_relative_humidity_percent",
              booth_id: "booth-01",
              source: "open_meteo",
            },
            value: [scrapeTimestamp, "67"],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_cloud_cover_percent",
              booth_id: "booth-01",
              source: "open_meteo",
            },
            value: [scrapeTimestamp, "12"],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_condition_info",
              booth_id: "booth-01",
              source: "open_meteo",
              condition: "overcast",
            },
            value: [scrapeTimestamp, "0"],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_condition_info",
              booth_id: "booth-01",
              source: "open_meteo",
              condition: "clear_sky",
            },
            value: [scrapeTimestamp, "1"],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_observation_timestamp_seconds",
              booth_id: "booth-01",
              source: "open_meteo",
            },
            value: [scrapeTimestamp, String(Date.parse(observedAt) / 1000)],
          },
          {
            metric: {
              __name__: "booth_outdoor_weather_last_success_timestamp_seconds",
              booth_id: "booth-01",
              source: "open_meteo",
            },
            value: [scrapeTimestamp, String(Date.parse(fetchedAt) / 1000)],
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("system current weather", () => {
  beforeEach(setup);

  it("requires operator authentication", async () => {
    const response = await createApp().request(currentPath());
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns normalized current weather from fixed PromQL", async () => {
    configureGrafana();
    fetchMock.mockResolvedValue(weatherResponse());

    const response = await createApp().request(currentPath(), {
      headers: { cookie: operatorCookie() },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      boothId: "booth-01",
      source: "open_meteo",
      temperatureCelsius: 22.2,
      relativeHumidityPercent: 67,
      cloudCoverPercent: 12,
      condition: "clear_sky",
      observedAt,
      fetchedAt,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, options] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe("/observability/api/datasources/proxy/uid/prom-main/api/v1/query");
    expect(url.searchParams.get("query")).toBe(buildCurrentWeatherQuery("booth-01"));
    expect(options?.redirect).toBe("error");
  });

  it("distinguishes missing configuration, no samples, and malformed samples", async () => {
    const app = createApp();
    const headers = { cookie: operatorCookie() };

    const unconfigured = await app.request(currentPath(), { headers });
    expect(unconfigured.status).toBe(503);
    await expect(unconfigured.json()).resolves.toEqual({ error: "weather_not_configured" });

    configureGrafana();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const missing = await app.request(currentPath(), { headers });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "weather_not_found" });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              {
                metric: {
                  __name__: "booth_outdoor_weather_temperature_celsius",
                  booth_id: "booth-01",
                  source: "open_meteo",
                },
                value: [scrapeTimestamp, "22.2"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const malformed = await app.request(currentPath(), { headers });
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toEqual({ error: "weather_upstream" });
  });

  it("escapes booth ids in the fixed selector", () => {
    expect(buildCurrentWeatherQuery('booth"\\01')).toContain('booth_id="booth\\"\\\\01"');
  });
});
