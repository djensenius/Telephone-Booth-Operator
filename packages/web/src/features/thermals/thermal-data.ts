import type {
  BoothSystemSnapshotEnvelope,
  TelemetrySourceEnvelope,
  TelemetryHistoryPoint,
  ThermalHistory,
  ThermalMetricName,
} from "@telephone-booth-operator/shared";

export const THERMAL_OFFLINE_AFTER_MS = 5 * 60 * 1000;

export interface ThermalCurrentSummary {
  readonly source: TelemetrySourceEnvelope;
  readonly piCpuTemperatureCelsius: number | null;
  readonly routerBatteryTemperatureCelsius: number | null;
  readonly hottestRouterZone: {
    readonly name: string;
    readonly temperatureCelsius: number;
  } | null;
  readonly lastSeenAt: string | null;
  readonly offline: boolean;
}

export interface ThermalChartSeries {
  readonly id: string;
  readonly label: string;
  readonly metric: ThermalMetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly points: readonly TelemetryHistoryPoint[];
}

export interface ThermalChartGroups {
  readonly combined: readonly ThermalChartSeries[];
  readonly cpu: readonly ThermalChartSeries[];
  readonly battery: readonly ThermalChartSeries[];
  readonly zones: readonly ThermalChartSeries[];
}

const orderedSources = (sources: readonly TelemetrySourceEnvelope[]): TelemetrySourceEnvelope[] =>
  [...sources].sort(
    (left, right) =>
      left.boothId.localeCompare(right.boothId) ||
      left.componentId.localeCompare(right.componentId) ||
      left.id.localeCompare(right.id),
  );

export function selectPreferredTelemetrySource(
  sources: readonly TelemetrySourceEnvelope[],
  selectedSourceId?: string,
): TelemetrySourceEnvelope | undefined {
  if (selectedSourceId) {
    const selected = sources.find((source) => source.id === selectedSourceId);
    if (selected) return selected;
  }
  const ordered = orderedSources(sources);
  return ordered.find((source) => source.componentId === "router") ?? ordered[0];
}

const finiteTemperature = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const validTimestamp = (timestamp: string | null | undefined): string | null =>
  timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;

export function buildFleetThermalSummaries(
  sources: readonly TelemetrySourceEnvelope[],
  systems: readonly BoothSystemSnapshotEnvelope[],
  nowMilliseconds: number = Date.now(),
): ThermalCurrentSummary[] {
  const systemsByBooth = new Map(systems.map((system) => [system.boothId, system]));
  return orderedSources(sources).map((source) => {
    const system = systemsByBooth.get(source.boothId);
    const zones = source.latestSnapshot?.thermalZones ?? [];
    const hottestRouterZone = zones.reduce<ThermalCurrentSummary["hottestRouterZone"]>(
      (hottest, zone) =>
        hottest === null || zone.temperatureCelsius > hottest.temperatureCelsius
          ? { name: zone.name, temperatureCelsius: zone.temperatureCelsius }
          : hottest,
      null,
    );
    const lastSeenAt = validTimestamp(source.receivedAt);
    return {
      source,
      piCpuTemperatureCelsius: finiteTemperature(system?.snapshot.temperatureCelsius),
      routerBatteryTemperatureCelsius: finiteTemperature(
        source.latestSnapshot?.battery?.temperatureCelsius,
      ),
      hottestRouterZone,
      lastSeenAt,
      offline:
        lastSeenAt === null || nowMilliseconds - Date.parse(lastSeenAt) >= THERMAL_OFFLINE_AFTER_MS,
    };
  });
}

const thermalZoneLabel = (labels: Readonly<Record<string, string>>, index: number): string =>
  labels.zone ??
  labels.thermal_zone ??
  labels.name ??
  labels.sensor ??
  `Router thermal zone ${index + 1}`;

export function thermalSeriesLabel(
  metric: ThermalMetricName,
  labels: Readonly<Record<string, string>>,
  index: number,
): string {
  if (metric === "booth_cpu_temperature_celsius") return "Pi CPU";
  if (metric === "glinet_battery_temperature_celsius") return "Router battery";
  return thermalZoneLabel(labels, index);
}

export function shapeThermalCharts(history: ThermalHistory | null): ThermalChartGroups {
  if (!history) return { combined: [], cpu: [], battery: [], zones: [] };
  const combined = history.series.map<ThermalChartSeries>((series, index) => ({
    id: `${series.metric}:${Object.entries(series.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join(",")}:${index}`,
    label: thermalSeriesLabel(series.metric, series.labels, index),
    metric: series.metric,
    labels: series.labels,
    points: series.points,
  }));
  return {
    combined,
    cpu: combined.filter((series) => series.metric === "booth_cpu_temperature_celsius"),
    battery: combined.filter((series) => series.metric === "glinet_battery_temperature_celsius"),
    zones: combined.filter((series) => series.metric === "glinet_thermal_temperature_celsius"),
  };
}

export function latestThermalPoint(
  series: ThermalChartSeries | undefined,
): TelemetryHistoryPoint | null {
  if (!series || series.points.length === 0) return null;
  return series.points.reduce((latest, point) =>
    point.timestamp > latest.timestamp ? point : latest,
  );
}
