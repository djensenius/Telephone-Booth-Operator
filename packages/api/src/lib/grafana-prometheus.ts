import {
  ROUTER_TELEMETRY_METRICS,
  RouterTelemetryMetricNameSchema,
  TELEMETRY_HISTORY_MAX_POINTS_PER_SERIES,
  TELEMETRY_HISTORY_MAX_SERIES,
  TELEMETRY_HISTORY_MAX_TOTAL_SAMPLES,
  type TelemetryHistorySeries,
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

export type GrafanaHistoryResult =
  | { ok: true; series: TelemetryHistorySeries[] }
  | { ok: false; reason: "not_configured" | "upstream" };

export const GRAFANA_HISTORY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

const queryRangeUrl = (config: GrafanaPrometheusConfig, input: QueryRangeInput): URL => {
  const url = new URL(config.url);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/api/datasources/proxy/uid/${encodeURIComponent(
    config.datasourceUid,
  )}/api/v1/query_range`;
  url.search = "";
  url.hash = "";
  url.searchParams.set(
    "query",
    buildRouterTelemetrySelector(input.prometheusJob, input.prometheusInstance),
  );
  url.searchParams.set("start", input.from);
  url.searchParams.set("end", input.to);
  url.searchParams.set("step", String(input.stepSeconds));
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

const normalizeSeries = (
  response: z.infer<typeof prometheusResponseSchema>,
): TelemetryHistorySeries[] | null => {
  const series: TelemetryHistorySeries[] = [];
  let totalSamples = 0;
  for (const result of response.data.result) {
    const metricResult = RouterTelemetryMetricNameSchema.safeParse(result.metric.__name__);
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

export const queryRouterTelemetryHistory = async (
  input: QueryRangeInput,
): Promise<GrafanaHistoryResult> => {
  const config = resolveGrafanaConfig();
  if (!config) return { ok: false, reason: "not_configured" };

  let response: Response;
  try {
    response = await fetch(queryRangeUrl(config, input), {
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

  const parsed = prometheusResponseSchema.safeParse(boundedJson.payload);
  if (!parsed.success) {
    log.error({
      event: "telemetry.grafana_invalid_response",
      issueCount: parsed.error.issues.length,
    });
    return { ok: false, reason: "upstream" };
  }

  const series = normalizeSeries(parsed.data);
  if (!series) {
    log.error({ event: "telemetry.grafana_invalid_series" });
    return { ok: false, reason: "upstream" };
  }
  return { ok: true, series };
};
