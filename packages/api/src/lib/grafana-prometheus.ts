import {
  CurrentWeatherConditionSchema,
  CurrentWeatherSchema,
  ROUTER_TELEMETRY_METRICS,
  RouterTelemetryMetricNameSchema,
  TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES,
  TELEMETRY_HISTORY_MAX_SERIES,
  TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES,
  ThermalMetricNameSchema,
  type CurrentWeather,
  type TelemetryHistorySeries,
  type ThermalHistorySeries,
} from "@telephone-booth-operator/shared";
import { z } from "zod";
import { log } from "./logger.js";

type GrafanaPrometheusConfig = {
  url: URL;
  serviceAccountToken: string;
  datasourceUid: string;
};

type QueryRangeInput = {
  prometheusJob: string;
  prometheusInstance: string;
  from: string;
  to: string;
  stepSeconds: number;
};

type ThermalQueryRangeInput = QueryRangeInput & {
  boothId: string;
};

type CurrentWeatherQueryInput = {
  boothId: string;
};

type GrafanaQueryRangeInput = {
  query: string;
  from: string;
  to: string;
  stepSeconds: number;
};

export type GrafanaHistoryResult =
  | { ok: true; series: TelemetryHistorySeries[] }
  | { ok: false; reason: "not_configured" | "upstream" };

export type GrafanaThermalHistoryResult =
  | { ok: true; series: ThermalHistorySeries[] }
  | { ok: false; reason: "not_configured" | "upstream" };

export type GrafanaCurrentWeatherResult =
  | { ok: true; weather: CurrentWeather }
  | { ok: false; reason: "not_configured" | "not_found" | "upstream" };

export const GRAFANA_HISTORY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const CURRENT_WEATHER_METRICS = [
  "booth_outdoor_weather_temperature_celsius",
  "booth_outdoor_weather_relative_humidity_percent",
  "booth_outdoor_weather_cloud_cover_percent",
  "booth_outdoor_weather_condition_info",
  "booth_outdoor_weather_observation_timestamp_seconds",
  "booth_outdoor_weather_last_success_timestamp_seconds",
] as const;

const CurrentWeatherMetricNameSchema = z.enum(CURRENT_WEATHER_METRICS);
type CurrentWeatherMetricName = z.infer<typeof CurrentWeatherMetricNameSchema>;

const prometheusSampleSchema = z.tuple([
  z.union([z.number(), z.string()]),
  z.union([z.number(), z.string()]),
]);

const prometheusResponseSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z
      .array(
        z.object({
          metric: z.record(z.string(), z.string()),
          values: z.array(prometheusSampleSchema).max(TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES),
        }),
      )
      .max(TELEMETRY_HISTORY_MAX_SERIES),
  }),
});

const prometheusInstantResponseSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("vector"),
    result: z
      .array(
        z.object({
          metric: z.record(z.string(), z.string()),
          value: prometheusSampleSchema,
        }),
      )
      .max(CURRENT_WEATHER_METRICS.length + 20),
  }),
});

const configuredValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const resolveGrafanaConfig = (
  env: NodeJS.ProcessEnv = process.env,
): GrafanaPrometheusConfig | null => {
  const urlValue = configuredValue(env.GRAFANA_URL);
  const serviceAccountToken = configuredValue(env.GRAFANA_SERVICE_ACCOUNT_TOKEN);
  const datasourceUid = configuredValue(env.GRAFANA_PROMETHEUS_DATASOURCE_UID);
  if (!urlValue || !serviceAccountToken || !datasourceUid) return null;

  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return null;
    return { url, serviceAccountToken, datasourceUid };
  } catch {
    return null;
  }
};

export const escapePrometheusLabelValue = (value: string): string =>
  JSON.stringify(value).slice(1, -1);

export const buildRouterTelemetrySelector = (
  prometheusJob: string,
  prometheusInstance: string,
): string => {
  const metricPattern = ROUTER_TELEMETRY_METRICS.join("|");
  return `{__name__=~"^(${metricPattern})$",job="${escapePrometheusLabelValue(
    prometheusJob,
  )}",instance="${escapePrometheusLabelValue(prometheusInstance)}"}`;
};

export const buildThermalHistoryQuery = (
  boothId: string,
  prometheusJob: string,
  prometheusInstance: string,
): string => {
  const boothSelector = `booth_cpu_temperature_celsius{booth_id="${escapePrometheusLabelValue(
    boothId,
  )}"}`;
  const routerLabels = `job="${escapePrometheusLabelValue(
    prometheusJob,
  )}",instance="${escapePrometheusLabelValue(prometheusInstance)}"`;
  return [
    boothSelector,
    `glinet_battery_temperature_celsius{${routerLabels}}`,
    `glinet_thermal_temperature_celsius{${routerLabels}}`,
  ].join(" or ");
};

export const buildCurrentWeatherQuery = (boothId: string): string => {
  const metricPattern = CURRENT_WEATHER_METRICS.join("|");
  return `{__name__=~"^(${metricPattern})$",booth_id="${escapePrometheusLabelValue(
    boothId,
  )}",source="open_meteo"}`;
};

const queryRangeUrl = (config: GrafanaPrometheusConfig, input: GrafanaQueryRangeInput): URL => {
  const url = new URL(config.url);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/datasources/proxy/uid/${encodeURIComponent(
    config.datasourceUid,
  )}/api/v1/query_range`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("query", input.query);
  url.searchParams.set("start", input.from);
  url.searchParams.set("end", input.to);
  url.searchParams.set("step", String(input.stepSeconds));
  return url;
};

const instantQueryUrl = (config: GrafanaPrometheusConfig, query: string): URL => {
  const url = new URL(config.url);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/datasources/proxy/uid/${encodeURIComponent(
    config.datasourceUid,
  )}/api/v1/query`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("query", query);
  return url;
};

type BoundedJsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: "too_large" | "read_failed" | "invalid_json"; error?: string };

const readBoundedJson = async (response: Response): Promise<BoundedJsonResult> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > GRAFANA_HISTORY_MAX_RESPONSE_BYTES) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
  }
  if (!response.body) return { ok: false, reason: "invalid_json" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > GRAFANA_HISTORY_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    return {
      ok: false,
      reason: "read_failed",
      error: error instanceof Error ? error.name : "unknown",
    };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      error: error instanceof Error ? error.name : "unknown",
    };
  }
};

const fetchGrafanaPayload = async (
  config: GrafanaPrometheusConfig,
  url: URL,
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: "upstream" }> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.serviceAccountToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    log.error({
      event: "telemetry.grafana_request_failed",
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false, reason: "upstream" };
  }

  if (!response.ok) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    log.error({
      event: "telemetry.grafana_bad_status",
      status: response.status,
      datasourceUid: config.datasourceUid,
    });
    return { ok: false, reason: "upstream" };
  }

  const boundedJson = await readBoundedJson(response);
  if (!boundedJson.ok) {
    log.error({
      event:
        boundedJson.reason === "too_large"
          ? "telemetry.grafana_response_too_large"
          : "telemetry.grafana_response_unreadable",
      limitBytes: GRAFANA_HISTORY_MAX_RESPONSE_BYTES,
      error: boundedJson.error,
    });
    return { ok: false, reason: "upstream" };
  }
  return boundedJson;
};

type NormalizedHistorySeries<Metric extends string> = {
  metric: Metric;
  labels: Record<string, string>;
  points: Array<{ timestamp: number; value: number }>;
};

const normalizeSeries = <Metric extends string>(
  response: z.infer<typeof prometheusResponseSchema>,
  metricSchema: z.ZodType<Metric>,
): NormalizedHistorySeries<Metric>[] | null => {
  const series: NormalizedHistorySeries<Metric>[] = [];
  let totalSamples = 0;
  for (const result of response.data.result) {
    const metricResult = metricSchema.safeParse(result.metric.__name__);
    if (!metricResult.success) return null;
    totalSamples += result.values.length;
    if (totalSamples > TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES) return null;

    const labels = Object.fromEntries(
      Object.entries(result.metric).filter(([name]) => name !== "__name__"),
    );
    const points = result.values.map(([rawTimestamp, rawValue]) => ({
      timestamp: Number(rawTimestamp),
      value: Number(rawValue),
    }));
    if (
      points.some(
        (point) =>
          !Number.isFinite(point.timestamp) || point.timestamp < 0 || !Number.isFinite(point.value),
      )
    ) {
      return null;
    }
    series.push({ metric: metricResult.data, labels, points });
  }
  return series;
};

const queryGrafanaHistory = async <Metric extends string>(
  input: GrafanaQueryRangeInput,
  metricSchema: z.ZodType<Metric>,
): Promise<
  | { ok: true; series: NormalizedHistorySeries<Metric>[] }
  | { ok: false; reason: "not_configured" | "upstream" }
> => {
  const config = resolveGrafanaConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const payload = await fetchGrafanaPayload(config, queryRangeUrl(config, input));
  if (!payload.ok) return payload;

  const parsed = prometheusResponseSchema.safeParse(payload.payload);
  if (!parsed.success) {
    log.error({
      event: "telemetry.grafana_invalid_response",
      issueCount: parsed.error.issues.length,
    });
    return { ok: false, reason: "upstream" };
  }

  const series = normalizeSeries(parsed.data, metricSchema);
  if (!series) {
    log.error({ event: "telemetry.grafana_invalid_series" });
    return { ok: false, reason: "upstream" };
  }
  return { ok: true, series };
};

const normalizeCurrentWeather = (
  response: z.infer<typeof prometheusInstantResponseSchema>,
  boothId: string,
): GrafanaCurrentWeatherResult => {
  if (response.data.result.length === 0) return { ok: false, reason: "not_found" };

  const scalarValues = new Map<CurrentWeatherMetricName, number>();
  let condition: z.infer<typeof CurrentWeatherConditionSchema> | null = null;
  for (const result of response.data.result) {
    const metricResult = CurrentWeatherMetricNameSchema.safeParse(result.metric.__name__);
    if (
      !metricResult.success ||
      result.metric.booth_id !== boothId ||
      result.metric.source !== "open_meteo"
    ) {
      return { ok: false, reason: "upstream" };
    }

    const sampleTimestamp = Number(result.value[0]);
    const value = Number(result.value[1]);
    if (!Number.isFinite(sampleTimestamp) || sampleTimestamp < 0 || !Number.isFinite(value)) {
      return { ok: false, reason: "upstream" };
    }

    if (metricResult.data === "booth_outdoor_weather_condition_info") {
      if (value !== 0 && value !== 1) return { ok: false, reason: "upstream" };
      if (value === 1) {
        const parsedCondition = CurrentWeatherConditionSchema.safeParse(result.metric.condition);
        if (!parsedCondition.success || condition !== null) {
          return { ok: false, reason: "upstream" };
        }
        condition = parsedCondition.data;
      }
    } else {
      if (scalarValues.has(metricResult.data)) return { ok: false, reason: "upstream" };
      scalarValues.set(metricResult.data, value);
    }
  }

  const temperatureCelsius = scalarValues.get("booth_outdoor_weather_temperature_celsius");
  const relativeHumidityPercent = scalarValues.get(
    "booth_outdoor_weather_relative_humidity_percent",
  );
  const cloudCoverPercent = scalarValues.get("booth_outdoor_weather_cloud_cover_percent");
  const observationTimestamp = scalarValues.get(
    "booth_outdoor_weather_observation_timestamp_seconds",
  );
  const fetchTimestamp = scalarValues.get("booth_outdoor_weather_last_success_timestamp_seconds");
  if (
    temperatureCelsius === undefined ||
    relativeHumidityPercent === undefined ||
    cloudCoverPercent === undefined ||
    observationTimestamp === undefined ||
    fetchTimestamp === undefined ||
    observationTimestamp <= 0 ||
    fetchTimestamp <= 0 ||
    condition === null
  ) {
    return { ok: false, reason: "upstream" };
  }

  const observedAt = new Date(observationTimestamp * 1000);
  const fetchedAt = new Date(fetchTimestamp * 1000);
  if (!Number.isFinite(observedAt.getTime()) || !Number.isFinite(fetchedAt.getTime())) {
    return { ok: false, reason: "upstream" };
  }

  const weather = CurrentWeatherSchema.safeParse({
    boothId,
    source: "open_meteo",
    temperatureCelsius,
    relativeHumidityPercent,
    cloudCoverPercent,
    condition,
    observedAt: observedAt.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
  });
  return weather.success ? { ok: true, weather: weather.data } : { ok: false, reason: "upstream" };
};

export const queryRouterTelemetryHistory = (
  input: QueryRangeInput,
): Promise<GrafanaHistoryResult> =>
  queryGrafanaHistory(
    {
      query: buildRouterTelemetrySelector(input.prometheusJob, input.prometheusInstance),
      from: input.from,
      to: input.to,
      stepSeconds: input.stepSeconds,
    },
    RouterTelemetryMetricNameSchema,
  );

export const queryThermalHistory = (
  input: ThermalQueryRangeInput,
): Promise<GrafanaThermalHistoryResult> =>
  queryGrafanaHistory(
    {
      query: buildThermalHistoryQuery(input.boothId, input.prometheusJob, input.prometheusInstance),
      from: input.from,
      to: input.to,
      stepSeconds: input.stepSeconds,
    },
    ThermalMetricNameSchema,
  );

export const queryCurrentWeather = async (
  input: CurrentWeatherQueryInput,
): Promise<GrafanaCurrentWeatherResult> => {
  const config = resolveGrafanaConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  const payload = await fetchGrafanaPayload(
    config,
    instantQueryUrl(config, buildCurrentWeatherQuery(input.boothId)),
  );
  if (!payload.ok) return payload;

  const parsed = prometheusInstantResponseSchema.safeParse(payload.payload);
  if (!parsed.success) {
    log.error({
      event: "telemetry.grafana_invalid_weather_response",
      issueCount: parsed.error.issues.length,
    });
    return { ok: false, reason: "upstream" };
  }

  const weather = normalizeCurrentWeather(parsed.data, input.boothId);
  if (!weather.ok && weather.reason === "upstream") {
    log.error({ event: "telemetry.grafana_invalid_weather_series" });
  }
  return weather;
};
