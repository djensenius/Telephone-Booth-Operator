import type { JSX } from "react";
import { memo, useId, useMemo } from "react";
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
const PROMETHEUS_GAP_MULTIPLIER = 1.5;
const CHART_COLOR_COUNT = 6;
const CHART_MARKER_COUNT = 3;
const CHART_DASH_PATTERNS: readonly (string | undefined)[] = [
  undefined,
  "10 4",
  "3 4",
  "10 3 2 3",
  "1 4",
  "14 4 3 4",
  "6 3 1 3",
  "2 2",
];

interface ThermalChartProps {
  readonly title: string;
  readonly description: string;
  readonly series: readonly ThermalChartSeries[];
  readonly from: string;
  readonly to: string;
  readonly stepSeconds: number;
}

interface ChartDomain {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

interface SeriesVisualCue {
  readonly paletteIndex: number;
  readonly markerIndex: number;
  readonly dashPattern: string | undefined;
}

interface SeriesGeometry {
  readonly path: string;
  readonly singletonPoints: readonly TelemetryHistoryPoint[];
}

const temperatureFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const formatTemperature = (value: number): string => `${temperatureFormatter.format(value)} °C`;

const visualCueForIndex = (index: number): SeriesVisualCue => {
  const patternGroup = Math.floor(index / CHART_COLOR_COUNT);
  return {
    paletteIndex: index % CHART_COLOR_COUNT,
    dashPattern: CHART_DASH_PATTERNS[patternGroup % CHART_DASH_PATTERNS.length],
    markerIndex: Math.floor(patternGroup / CHART_DASH_PATTERNS.length) % CHART_MARKER_COUNT,
  };
};

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

const geometryForSeries = (
  series: ThermalChartSeries,
  domain: ChartDomain,
  stepSeconds: number,
): SeriesGeometry => {
  let previousTimestamp: number | null = null;
  let segmentStart: TelemetryHistoryPoint | null = null;
  let segmentPointCount = 0;
  const commands: string[] = [];
  const singletonPoints: TelemetryHistoryPoint[] = [];
  for (const point of [...series.points].sort((left, right) => left.timestamp - right.timestamp)) {
    const startsSegment =
      previousTimestamp === null ||
      point.timestamp - previousTimestamp > stepSeconds * PROMETHEUS_GAP_MULTIPLIER;
    if (startsSegment) {
      if (segmentPointCount === 1 && segmentStart) singletonPoints.push(segmentStart);
      segmentStart = point;
      segmentPointCount = 1;
    } else {
      segmentPointCount += 1;
    }
    const { x, y } = pointCoordinates(point, domain);
    commands.push(`${startsSegment ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    previousTimestamp = point.timestamp;
  }
  if (segmentPointCount === 1 && segmentStart) singletonPoints.push(segmentStart);
  return { path: commands.join(" "), singletonPoints };
};

const timeLabel = (timestampSeconds: number): string =>
  new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function SeriesMarker({
  x,
  y,
  markerIndex,
  paletteIndex,
  size = 4,
}: {
  readonly x: number;
  readonly y: number;
  readonly markerIndex: number;
  readonly paletteIndex: number;
  readonly size?: number;
}): JSX.Element {
  const className = `thermal-chart__point thermal-chart__line--${paletteIndex}`;
  if (markerIndex === 1) {
    return (
      <rect className={className} x={x - size} y={y - size} width={size * 2} height={size * 2} />
    );
  }
  if (markerIndex === 2) {
    return (
      <polygon
        className={className}
        points={`${x},${y - size} ${x + size},${y + size} ${x - size},${y + size}`}
      />
    );
  }
  return <circle className={className} cx={x} cy={y} r={size} />;
}

export const ThermalChart = memo(function ThermalChart({
  title,
  description,
  series,
  from,
  to,
  stepSeconds,
}: ThermalChartProps): JSX.Element {
  const id = useId().replaceAll(":", "");
  const titleId = `thermal-chart-title-${id}`;
  const descriptionId = `thermal-chart-description-${id}`;
  const clipId = `thermal-chart-clip-${id}`;
  const domain = useMemo(() => chartDomain(series, from, to), [from, series, to]);
  const orderedSeries = useMemo(
    () => [...series].sort((left, right) => left.id.localeCompare(right.id)),
    [series],
  );
  const yTicks = useMemo(
    () =>
      domain === null
        ? []
        : Array.from(
            { length: Y_TICK_COUNT },
            (_, index) => domain.yMax - (index / (Y_TICK_COUNT - 1)) * (domain.yMax - domain.yMin),
          ),
    [domain],
  );
  const preparedSeries = useMemo(() => {
    if (domain === null) return [];
    return orderedSeries.map((item, index) => {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const point of item.points) {
        minimum = Math.min(minimum, point.value);
        maximum = Math.max(maximum, point.value);
      }
      const latest = latestThermalPoint(item);
      const visualCue = visualCueForIndex(index);
      const geometry = geometryForSeries(item, domain, stepSeconds);
      const markerPoints = [...geometry.singletonPoints];
      if (latest && !markerPoints.includes(latest)) markerPoints.push(latest);
      return {
        item,
        latest,
        minimum,
        maximum,
        ...visualCue,
        path: geometry.path,
        markerCoordinates: markerPoints.map((point) => ({
          ...pointCoordinates(point, domain),
          timestamp: point.timestamp,
        })),
      };
    });
  }, [domain, orderedSeries, stepSeconds]);

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
                {preparedSeries.map(
                  ({ item, markerCoordinates, paletteIndex, markerIndex, dashPattern, path }) => {
                    return (
                      <g key={item.id} data-series-id={item.id}>
                        <path
                          className={`thermal-chart__line thermal-chart__line--${paletteIndex}`}
                          d={path}
                          strokeDasharray={dashPattern}
                        />
                        {markerCoordinates.map((coordinates, markerPosition) => (
                          <SeriesMarker
                            key={`${coordinates.timestamp}:${markerPosition}`}
                            x={coordinates.x}
                            y={coordinates.y}
                            markerIndex={markerIndex}
                            paletteIndex={paletteIndex}
                          />
                        ))}
                      </g>
                    );
                  },
                )}
              </g>
            </svg>
          </div>
          <ul className="thermal-chart__legend" aria-label={`${title} legend`}>
            {preparedSeries.map(({ item, latest, paletteIndex, markerIndex, dashPattern }) => {
              return (
                <li key={item.id}>
                  <svg
                    className={`thermal-chart__legend-cue thermal-chart__line--${paletteIndex}`}
                    viewBox="0 0 24 10"
                    aria-hidden="true"
                  >
                    <line x1="1" x2="23" y1="5" y2="5" strokeDasharray={dashPattern} />
                    <SeriesMarker
                      x={12}
                      y={5}
                      markerIndex={markerIndex}
                      paletteIndex={paletteIndex}
                      size={3}
                    />
                  </svg>
                  <span>{item.label}</span>
                  <strong>{latest === null ? "—" : formatTemperature(latest.value)}</strong>
                </li>
              );
            })}
          </ul>
          <div className="visually-hidden">
            {preparedSeries.map(({ item, latest, minimum, maximum }) => {
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
});
