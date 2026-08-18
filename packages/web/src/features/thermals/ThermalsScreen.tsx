import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { TelemetryHistoryPoint } from "@telephone-booth-operator/shared";
import { GlassPanel } from "../../components/booth/index.js";
import {
  THERMAL_RANGE_VALUES,
  useComponentTelemetryCurrent,
  useSystemCurrentAll,
  useThermalHistory,
  type ThermalRange,
} from "../../lib/api-client.js";
import { FeatureEmpty, FeatureError, FeatureSkeleton } from "../common/FeatureStates.js";
import { fmtNumber } from "../system/format.js";
import { ThermalChart } from "./ThermalChart.js";
import {
  buildFleetThermalSummaries,
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

const formatLastSeen = (iso: string | null): string =>
  iso === null ? "Awaiting telemetry" : `Last update ${new Date(iso).toLocaleString()}`;

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
    <div className="thermal-current-tile">
      <span>{label}</span>
      <strong>{formatCurrentTemperature(value)}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
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

function SensorDetails({
  title,
  series,
  children,
}: {
  readonly title: string;
  readonly series: readonly ThermalChartSeries[];
  readonly children: ReactNode;
}): JSX.Element {
  const latest = newestPoint(series);
  return (
    <details className="thermal-sensor-details">
      <summary>
        <span>{title}</span>
        <strong>{latest === null ? "No samples" : `${fmtNumber(latest.value, 1)} °C`}</strong>
      </summary>
      {children}
    </details>
  );
}

export function ThermalsScreen(): JSX.Element {
  const systemsQuery = useSystemCurrentAll();
  const componentsQuery = useComponentTelemetryCurrent();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [range, setRange] = useState<ThermalRange>("24h");
  const sources = useMemo(() => componentsQuery.data ?? [], [componentsQuery.data]);
  const systems = useMemo(() => systemsQuery.data?.items ?? [], [systemsQuery.data]);
  const selectedSource = useMemo(
    () => selectPreferredTelemetrySource(sources, selectedSourceId),
    [selectedSourceId, sources],
  );
  const summaries = useMemo(() => buildFleetThermalSummaries(sources, systems), [sources, systems]);
  const selectedSummary = summaries.find((summary) => summary.source.id === selectedSource?.id);
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
            Current temperatures across the fleet and fixed, allowlisted history for the selected
            booth.
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
              />
              <div className="thermal-sensor-list">
                <SensorDetails title="Pi CPU sensor" series={charts.cpu}>
                  <ThermalChart
                    title="Pi CPU"
                    description="Booth host CPU temperature."
                    series={charts.cpu}
                    from={history.from}
                    to={history.to}
                  />
                </SensorDetails>
                <SensorDetails title="Router battery sensor" series={charts.battery}>
                  <ThermalChart
                    title="Router battery"
                    description="Battery-pack temperature reported by the selected router."
                    series={charts.battery}
                    from={history.from}
                    to={history.to}
                  />
                </SensorDetails>
                {charts.zones.map((zone) => (
                  <SensorDetails key={zone.id} title={zone.label} series={[zone]}>
                    <ThermalChart
                      title={zone.label}
                      description="Individual router thermal-zone temperature."
                      series={[zone]}
                      from={history.from}
                      to={history.to}
                    />
                  </SensorDetails>
                ))}
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </GlassPanel>
  );
}
