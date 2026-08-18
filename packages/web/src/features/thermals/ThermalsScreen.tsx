import type { JSX } from "react";
import { memo, useMemo, useState } from "react";
import type { TelemetryHistoryPoint } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import { useNow } from "../../hooks/useNow.js";
import {
  THERMAL_RANGE_VALUES,
  useComponentTelemetryCurrent,
  useCurrentWeather,
  useSystemCurrentAll,
  useThermalHistory,
  type ThermalRange,
} from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { fmtNumber } from "../system/format.js";
import { ThermalChart } from "./ThermalChart.js";
import {
  buildFleetThermalSummaries,
  formatWeatherCondition,
  isCurrentWeatherFresh,
  latestThermalPoint,
  selectPreferredTelemetrySource,
  shapeThermalCharts,
  type ThermalChartSeries,
  type ThermalCurrentSummary,
} from "./thermal-data.js";

const RANGE_LABELS: Record<ThermalRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const formatCurrentTemperature = (value: number | null): string =>
  value === null ? "—" : `${fmtNumber(value, 1)} °C`;

const formatPercent = (value: number): string => `${fmtNumber(value, 0)}%`;

const formatLastSeen = (iso: string | null): string =>
  iso === null ? "Awaiting telemetry" : `Last update ${new Date(iso).toLocaleString()}`;

function CurrentValue({
  label,
  value,
  hint,
  text = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly text?: boolean;
}): JSX.Element {
  return (
    <div className={`thermal-current-tile${text ? " thermal-current-tile--text" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function CurrentTemperature({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly hint?: string;
}): JSX.Element {
  return (
    <CurrentValue
      label={label}
      value={formatCurrentTemperature(value)}
      {...(hint ? { hint } : {})}
    />
  );
}

function FleetSourceCard({
  summary,
  selected,
  onSelect,
}: {
  readonly summary: ThermalCurrentSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const hottest = summary.hottestRouterZone;
  return (
    <button
      type="button"
      className={`thermal-fleet-card${selected ? " thermal-fleet-card--selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="thermal-fleet-card__header">
        <span>
          <strong>{summary.source.boothId}</strong>
          <small>
            {summary.source.displayName} · {summary.source.componentId}
          </small>
        </span>
        <span
          className={`thermal-fleet-card__status thermal-fleet-card__status--${
            summary.offline ? "offline" : "online"
          }`}
        >
          {summary.offline ? "Offline" : "Current"}
        </span>
      </span>
      <span className="thermal-fleet-card__readings">
        <span>
          <small>Pi CPU</small>
          <strong>{formatCurrentTemperature(summary.piCpuTemperatureCelsius)}</strong>
        </span>
        <span>
          <small>Router battery</small>
          <strong>{formatCurrentTemperature(summary.routerBatteryTemperatureCelsius)}</strong>
        </span>
        <span>
          <small>{hottest?.name ?? "Hottest zone"}</small>
          <strong>{formatCurrentTemperature(hottest?.temperatureCelsius ?? null)}</strong>
        </span>
      </span>
      <span className="thermal-fleet-card__time">{formatLastSeen(summary.lastSeenAt)}</span>
    </button>
  );
}

const newestPoint = (series: readonly ThermalChartSeries[]): TelemetryHistoryPoint | null => {
  let newest: TelemetryHistoryPoint | null = null;
  for (const item of series) {
    const latest = latestThermalPoint(item);
    if (latest && (newest === null || latest.timestamp > newest.timestamp)) newest = latest;
  }
  return newest;
};

interface SensorDetailsProps {
  readonly title: string;
  readonly chartTitle: string;
  readonly description: string;
  readonly series: readonly ThermalChartSeries[];
  readonly from: string;
  readonly to: string;
  readonly stepSeconds: number;
}

const SensorDetails = memo(function SensorDetails({
  title,
  chartTitle,
  description,
  series,
  from,
  to,
  stepSeconds,
}: SensorDetailsProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const latest = useMemo(() => newestPoint(series), [series]);
  return (
    <details
      className="thermal-sensor-details"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{title}</span>
        <strong>{latest === null ? "No samples" : `${fmtNumber(latest.value, 1)} °C`}</strong>
      </summary>
      {isOpen ? (
        <ThermalChart
          title={chartTitle}
          description={description}
          series={series}
          from={from}
          to={to}
          stepSeconds={stepSeconds}
        />
      ) : null}
    </details>
  );
});

const ZoneSensorDetails = memo(function ZoneSensorDetails({
  zone,
  from,
  to,
  stepSeconds,
}: {
  readonly zone: ThermalChartSeries;
  readonly from: string;
  readonly to: string;
  readonly stepSeconds: number;
}): JSX.Element {
  const series = useMemo(() => [zone], [zone]);
  return (
    <SensorDetails
      title={zone.label}
      chartTitle={zone.label}
      description="Individual router thermal-zone temperature."
      series={series}
      from={from}
      to={to}
      stepSeconds={stepSeconds}
    />
  );
});

export function ThermalsScreen(): JSX.Element {
  const systemsQuery = useSystemCurrentAll();
  const componentsQuery = useComponentTelemetryCurrent();
  const nowMilliseconds = useNow();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [range, setRange] = useState<ThermalRange>("24h");
  const sources = useMemo(() => componentsQuery.data ?? [], [componentsQuery.data]);
  const systems = useMemo(() => systemsQuery.data?.items ?? [], [systemsQuery.data]);
  const selectedSource = useMemo(
    () => selectPreferredTelemetrySource(sources, selectedSourceId),
    [selectedSourceId, sources],
  );
  const summaries = useMemo(
    () => buildFleetThermalSummaries(sources, systems, nowMilliseconds),
    [nowMilliseconds, sources, systems],
  );
  const selectedSummary = summaries.find((summary) => summary.source.id === selectedSource?.id);
  const weatherQuery = useCurrentWeather(selectedSource?.boothId);
  const weather = weatherQuery.data ?? null;
  const weatherIsFresh = isCurrentWeatherFresh(weather?.fetchedAt, nowMilliseconds);
  const historyQuery = useThermalHistory(selectedSource, range);
  const history = historyQuery.data ?? null;
  const charts = useMemo(() => shapeThermalCharts(history), [history]);
  const currentLoading =
    (componentsQuery.isPending && sources.length === 0) ||
    (systemsQuery.isPending && systems.length === 0);
  const currentError =
    (componentsQuery.isError && sources.length === 0) ||
    (systemsQuery.isError && systems.length === 0);

  return (
    <GlassPanel title="Thermals" className="feature-screen thermals-screen">
      <header className="thermals-screen__header">
        <div>
          <span className="screen-kicker">Observability</span>
          <h1>Thermals</h1>
          <p>
            Current temperatures and outdoor weather across the fleet, with fixed allowlisted
            thermal history for the selected booth.
          </p>
        </div>
        <div className="thermals-screen__controls">
          {sources.length > 1 && selectedSource ? (
            <label className="thermal-source-picker">
              <span>Booth and source</span>
              <select
                value={selectedSource.id}
                onChange={(event) => setSelectedSourceId(event.target.value)}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.boothId} — {source.displayName} ({source.componentId})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <fieldset className="thermal-range-picker" aria-label="History range">
            <legend className="visually-hidden">History range</legend>
            {THERMAL_RANGE_VALUES.map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="thermal-range"
                  value={option}
                  checked={range === option}
                  onChange={() => setRange(option)}
                />
                <span>{RANGE_LABELS[option]}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </header>

      {currentLoading ? <FeatureSkeleton label="Reading fleet thermometers…" /> : null}
      {currentError ? (
        <FeatureError message="Current booth or router telemetry is unavailable." />
      ) : null}
      {!currentLoading && !currentError && sources.length === 0 ? (
        <FeatureEmpty title="No router telemetry sources">
          Create a telemetry-scoped router source before thermal history can be selected.
        </FeatureEmpty>
      ) : null}

      {selectedSummary ? (
        <section className="thermal-selected-current" aria-labelledby="selected-current-title">
          <header>
            <div>
              <h2 id="selected-current-title">{selectedSummary.source.boothId} now</h2>
              <p>
                {selectedSummary.source.displayName} · {selectedSummary.source.componentId}
              </p>
            </div>
            <span className={selectedSummary.offline ? "thermal-offline" : "thermal-online"}>
              {selectedSummary.offline ? "Telemetry offline" : "Telemetry current"}
            </span>
          </header>
          <div className="thermal-current-grid">
            <CurrentTemperature label="Pi CPU" value={selectedSummary.piCpuTemperatureCelsius} />
            <CurrentTemperature
              label="Router battery"
              value={selectedSummary.routerBatteryTemperatureCelsius}
            />
            <CurrentTemperature
              label="Hottest router zone"
              value={selectedSummary.hottestRouterZone?.temperatureCelsius ?? null}
              {...(selectedSummary.hottestRouterZone
                ? { hint: selectedSummary.hottestRouterZone.name }
                : {})}
            />
          </div>
        </section>
      ) : null}

      {selectedSource ? (
        <section className="thermal-weather" aria-labelledby="thermal-weather-title">
          <header>
            <div>
              <h2 id="thermal-weather-title">Current outdoor weather</h2>
              <p>Modeled Open-Meteo context for {selectedSource.boothId}.</p>
            </div>
            {weather ? (
              <span className={weatherIsFresh ? "thermal-online" : "thermal-offline"}>
                {weatherIsFresh ? "Weather current" : "Weather stale"}
              </span>
            ) : null}
          </header>
          {weatherQuery.isPending ? <FeatureSkeleton label="Reading outdoor weather…" /> : null}
          {weatherQuery.isError && !weather ? (
            <FeatureError message="Current outdoor weather is unavailable." />
          ) : null}
          {weather ? (
            <>
              <div className="thermal-current-grid thermal-weather-grid">
                <CurrentValue
                  label="Outdoor temperature"
                  value={formatCurrentTemperature(weather.temperatureCelsius)}
                />
                <CurrentValue
                  label="Relative humidity"
                  value={formatPercent(weather.relativeHumidityPercent)}
                />
                <CurrentValue
                  label="Conditions"
                  value={formatWeatherCondition(weather.condition)}
                  text
                />
                <CurrentValue
                  label="Cloud cover"
                  value={formatPercent(weather.cloudCoverPercent)}
                />
              </div>
              <small className="thermal-weather__freshness">
                Observed {new Date(weather.observedAt).toLocaleString()} · fetched{" "}
                {new Date(weather.fetchedAt).toLocaleString()}
                {weatherQuery.isError ? " · latest refresh failed" : ""}
              </small>
            </>
          ) : null}
        </section>
      ) : null}

      {summaries.length > 0 ? (
        <section className="thermal-fleet" aria-labelledby="thermal-fleet-title">
          <header>
            <h2 id="thermal-fleet-title">Fleet current</h2>
            <p>Select a card to chart that booth and router source.</p>
          </header>
          <div className="thermal-fleet-grid">
            {summaries.map((summary) => (
              <FleetSourceCard
                key={summary.source.id}
                summary={summary}
                selected={summary.source.id === selectedSource?.id}
                onSelect={() => setSelectedSourceId(summary.source.id)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {selectedSource ? (
        <section className="thermal-history" aria-labelledby="thermal-history-title">
          <header className="thermal-history__header">
            <div>
              <h2 id="thermal-history-title">
                {selectedSource.boothId} · {RANGE_LABELS[range]}
              </h2>
              <p>
                Source {selectedSource.displayName} · Prometheus job{" "}
                <code>{selectedSource.prometheusJob}</code> · instance{" "}
                <code>{selectedSource.prometheusInstance}</code>
              </p>
            </div>
            {historyQuery.isFetching && history ? (
              <span className="thermal-history__refreshing">Refreshing…</span>
            ) : null}
          </header>
          {historyQuery.isPending ? <FeatureSkeleton label="Tracing temperature history…" /> : null}
          {historyQuery.isError ? (
            <FeatureError message="Thermal history is unavailable from Grafana." />
          ) : null}
          {history ? (
            <>
              <ThermalChart
                title="Combined thermal history"
                description="Pi CPU, router battery, and every reported router thermal zone."
                series={charts.combined}
                from={history.from}
                to={history.to}
                stepSeconds={history.stepSeconds}
              />
              <div className="thermal-sensor-list">
                <SensorDetails
                  title="Pi CPU sensor"
                  chartTitle="Pi CPU"
                  description="Booth host CPU temperature."
                  series={charts.cpu}
                  from={history.from}
                  to={history.to}
                  stepSeconds={history.stepSeconds}
                />
                <SensorDetails
                  title="Router battery sensor"
                  chartTitle="Router battery"
                  description="Battery-pack temperature reported by the selected router."
                  series={charts.battery}
                  from={history.from}
                  to={history.to}
                  stepSeconds={history.stepSeconds}
                />
                {charts.zones.map((zone) => (
                  <ZoneSensorDetails
                    key={zone.id}
                    zone={zone}
                    from={history.from}
                    to={history.to}
                    stepSeconds={history.stepSeconds}
                  />
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </GlassPanel>
  );
}
