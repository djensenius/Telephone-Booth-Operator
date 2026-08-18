import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { ThermalChart } from "./ThermalChart.js";
import type { ThermalChartSeries } from "./thermal-data.js";

describe("ThermalChart", () => {
  it("starts a new SVG segment after a Prometheus sampling gap", () => {
    const series: ThermalChartSeries[] = [
      {
        id: "cpu",
        label: "Pi CPU",
        metric: "booth_cpu_temperature_celsius",
        labels: { booth_id: "booth-01" },
        points: [
          { timestamp: 0, value: 47 },
          { timestamp: 60, value: 48 },
          { timestamp: 180, value: 49 },
        ],
      },
    ];
    const { container } = render(
      <ThermalChart
        title="Pi CPU"
        description="CPU history"
        series={series}
        from="1970-01-01T00:00:00.000Z"
        to="1970-01-01T01:00:00.000Z"
        stepSeconds={60}
      />,
    );

    const path = container.querySelector("path.thermal-chart__line");
    const commands = path?.getAttribute("d") ?? "";
    expect(commands.match(/\bM\b/g)).toHaveLength(2);
    expect(commands.match(/\bL\b/g)).toHaveLength(1);
  });

  it("renders a marker for every isolated singleton segment", () => {
    const series: ThermalChartSeries[] = [
      {
        id: "isolated-cpu",
        label: "Pi CPU",
        metric: "booth_cpu_temperature_celsius",
        labels: { booth_id: "booth-01" },
        points: [
          { timestamp: 0, value: 47 },
          { timestamp: 180, value: 48 },
          { timestamp: 360, value: 49 },
        ],
      },
    ];
    const { container } = render(
      <ThermalChart
        title="Pi CPU"
        description="CPU history"
        series={series}
        from="1970-01-01T00:00:00.000Z"
        to="1970-01-01T01:00:00.000Z"
        stepSeconds={60}
      />,
    );

    const group = container.querySelector('g[data-series-id="isolated-cpu"]');
    expect(group?.querySelectorAll(".thermal-chart__point")).toHaveLength(3);
    expect(group?.querySelector("path")?.getAttribute("d")?.match(/\bM\b/g)).toHaveLength(3);
  });

  it("assigns stable color, dash, and marker combinations across 128 series", () => {
    const series: ThermalChartSeries[] = Array.from({ length: 128 }, (_, index) => ({
      id: `series-${String(index).padStart(3, "0")}`,
      label: `Sensor ${index}`,
      metric: "glinet_thermal_temperature_celsius",
      labels: { zone: String(index) },
      points: [{ timestamp: index, value: 20 + index }],
    }));
    const props = {
      title: "Router zones",
      description: "All router zones",
      from: "1970-01-01T00:00:00.000Z",
      to: "1970-01-01T01:00:00.000Z",
      stepSeconds: 60,
    } as const;
    const { container, rerender } = render(<ThermalChart {...props} series={series} />);
    const readCues = (): Map<string, string> =>
      new Map(
        [...container.querySelectorAll<SVGGElement>("g[data-series-id]")].map((group) => {
          const id = group.dataset.seriesId;
          const line = group.querySelector("path.thermal-chart__line");
          const marker = group.querySelector(".thermal-chart__point");
          if (!id || !line || !marker) throw new Error("missing thermal series cue");
          return [
            id,
            [
              line.getAttribute("class"),
              line.getAttribute("stroke-dasharray") ?? "solid",
              marker.tagName,
            ].join("|"),
          ] as const;
        }),
      );

    const originalCues = readCues();
    expect(originalCues.size).toBe(128);
    expect(new Set(originalCues.values()).size).toBe(128);

    rerender(<ThermalChart {...props} series={[...series].reverse()} />);
    expect(readCues()).toEqual(originalCues);
  });
});
