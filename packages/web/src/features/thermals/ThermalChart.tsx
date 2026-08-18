import type { JSX } from "react";
import { useId } from "react";
import type { TelemetryHistoryPoint } from "@telephone-booth-operator/shared";
import type { ThermalChartSeries } from "./thermal-data.js";
import { latestThermalPoint } from "./thermal-data.js";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const PLOT_LEFT = 54;
const PLOT_RIGHT = 18;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 42;
const PLOT_WIDTH = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
const Y_TICK_COUNT = 5;

interface ThermalChartProps {
  readonly title: string;
  readonly description: string;
  readonly series: readonly ThermalChartSeries[];
  readonly from: string;
  readonly to: string;
}

interface ChartDomain {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

const temperatureFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const formatTemperature = (value: number): string => `${temperatureFormatter.format(value)} °C`;

const chartDomain = (
  series: readonly ThermalChartSeries[],
  from: string,
  to: string,
): ChartDomain | null => {
  let pointCount = 0;
  let dataXMin = Number.POSITIVE_INFINITY;
  let dataXMax = Number.NEGATIVE_INFINITY;
  let rawYMin = Number.POSITIVE_INFINITY;
  let rawYMax = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const point of item.points) {
      pointCount += 1;
      dataXMin = Math.min(dataXMin, point.timestamp);
      dataXMax = Math.max(dataXMax, point.timestamp);
      rawYMin = Math.min(rawYMin, point.value);
      rawYMax = Math.max(rawYMax, point.value);
    }
  }
  if (pointCount === 0) return null;
  const requestedFrom = Date.parse(from) / 1000;
  const requestedTo = Date.parse(to) / 1000;
  const xMin = Number.isFinite(requestedFrom) ? requestedFrom : dataXMin;
  const requestedRangeIsValid = Number.isFinite(requestedTo) && requestedTo > xMin;
  const xMax = requestedRangeIsValid ? requestedTo : Math.max(dataXMax, xMin + 1);
  const rawSpan = rawYMax - rawYMin;
  const padding = Math.max(rawSpan * 0.1, 1);
  return {
    xMin,
    xMax,
    yMin: rawYMin - padding,
    yMax: rawYMax + padding,
  };
};

const pointCoordinates = (
  point: TelemetryHistoryPoint,
  domain: ChartDomain,
): { readonly x: number; readonly y: number } => ({
  x: PLOT_LEFT + ((point.timestamp - domain.xMin) / (domain.xMax - domain.xMin)) * PLOT_WIDTH,
  y: PLOT_TOP + ((domain.yMax - point.value) / (domain.yMax - domain.yMin)) * PLOT_HEIGHT,
});

const pathForSeries = (series: ThermalChartSeries, domain: ChartDomain): string =>
  [...series.points]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((point, index) => {
      const { x, y } = pointCoordinates(point, domain);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

const timeLabel = (timestampSeconds: number): string =>
  new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function ThermalChart({
  title,
  description,
  series,
  from,
  to,
}: ThermalChartProps): JSX.Element {
  const id = useId().replaceAll(":", "");
  const titleId = `thermal-chart-title-${id}`;
  const descriptionId = `thermal-chart-description-${id}`;
  const clipId = `thermal-chart-clip-${id}`;
  const domain = chartDomain(series, from, to);
  const yTicks =
    domain === null
      ? []
      : Array.from(
          { length: Y_TICK_COUNT },
          (_, index) => domain.yMax - (index / (Y_TICK_COUNT - 1)) * (domain.yMax - domain.yMin),
        );

  return (
    <figure className="thermal-chart">
      <header className="thermal-chart__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        {domain === null ? null : (
          <span className="thermal-chart__range">
            {formatTemperature(domain.yMin)}–{formatTemperature(domain.yMax)}
          </span>
        )}
      </header>
      {domain === null ? (
        <div className="thermal-chart__empty" role="status">
          No samples in this range.
        </div>
      ) : (
        <>
          <div className="thermal-chart__canvas">
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="img"
              aria-labelledby={`${titleId} ${descriptionId}`}
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <clipPath id={clipId}>
                  <rect x={PLOT_LEFT} y={PLOT_TOP} width={PLOT_WIDTH} height={PLOT_HEIGHT} />
                </clipPath>
              </defs>
              {yTicks.map((tick) => {
                const y =
                  PLOT_TOP + ((domain.yMax - tick) / (domain.yMax - domain.yMin)) * PLOT_HEIGHT;
                return (
                  <g key={tick}>
                    <line
                      className="thermal-chart__grid-line"
                      x1={PLOT_LEFT}
                      x2={CHART_WIDTH - PLOT_RIGHT}
                      y1={y}
                      y2={y}
                    />
                    <text className="thermal-chart__axis-label" x={PLOT_LEFT - 8} y={y + 4}>
                      {temperatureFormatter.format(tick)}
                    </text>
                  </g>
                );
              })}
              <text
                className="thermal-chart__axis-label thermal-chart__axis-label--start"
                x={PLOT_LEFT}
                y={CHART_HEIGHT - 12}
              >
                {timeLabel(domain.xMin)}
              </text>
              <text
                className="thermal-chart__axis-label thermal-chart__axis-label--end"
                x={CHART_WIDTH - PLOT_RIGHT}
                y={CHART_HEIGHT - 12}
              >
                {timeLabel(domain.xMax)}
              </text>
              <g clipPath={`url(#${clipId})`}>
                {series.map((item, index) => {
                  const latest = latestThermalPoint(item);
                  const latestCoordinates =
                    latest === null ? null : pointCoordinates(latest, domain);
                  const paletteIndex = index % 6;
                  return (
                    <g key={item.id}>
                      <path
                        className={`thermal-chart__line thermal-chart__line--${paletteIndex}`}
                        d={pathForSeries(item, domain)}
                      />
                      {latestCoordinates === null ? null : (
                        <circle
                          className={`thermal-chart__point thermal-chart__line--${paletteIndex}`}
                          cx={latestCoordinates.x}
                          cy={latestCoordinates.y}
                          r="4"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
          <ul className="thermal-chart__legend" aria-label={`${title} legend`}>
            {series.map((item, index) => {
              const latest = latestThermalPoint(item);
              return (
                <li key={item.id}>
                  <span
                    className={`thermal-chart__legend-swatch thermal-chart__line--${index % 6}`}
                    aria-hidden="true"
                  />
                  <span>{item.label}</span>
                  <strong>{latest === null ? "—" : formatTemperature(latest.value)}</strong>
                </li>
              );
            })}
          </ul>
          <div className="visually-hidden">
            {series.map((item) => {
              let minimum = Number.POSITIVE_INFINITY;
              let maximum = Number.NEGATIVE_INFINITY;
              for (const point of item.points) {
                minimum = Math.min(minimum, point.value);
                maximum = Math.max(maximum, point.value);
              }
              const latest = latestThermalPoint(item);
              return (
                <p key={item.id}>
                  {item.label}: {item.points.length} samples
                  {item.points.length === 0
                    ? "."
                    : `, minimum ${formatTemperature(minimum)}, maximum ${formatTemperature(
                        maximum,
                      )}, latest ${latest === null ? "unavailable" : formatTemperature(latest.value)}.`}
                </p>
              );
            })}
          </div>
        </>
      )}
    </figure>
  );
}
