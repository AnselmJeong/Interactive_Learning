import { useId, useMemo } from "react";
import type { SideChatPlotExpression, SideChatVisualSpec } from "../../../shared/artifact-types";
import { evaluateSideChatPlotExpression, normalizeSideChatVisualSpec } from "../../../shared/side-chat-visual";
import { sanitizeDiagramSpec } from "../../../shared/diagram-spec";
import { DiagramView } from "./DiagramView";

const PLOT_WIDTH = 680;
const PLOT_HEIGHT = 390;
const PLOT_MARGIN = { top: 24, right: 24, bottom: 58, left: 72 };
const SERIES_CLASSES = ["series-a", "series-b", "series-c", "series-d"];

type PlotPoint = { x: number; y: number | null };
type RenderSeries = { label: string; points: PlotPoint[] };

function extent(values: number[]) {
  if (!values.length) return [0, 1] as const;
  let min = values[0]!;
  let max = values[0]!;
  for (const value of values.slice(1)) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    return [min - pad, max + pad] as const;
  }
  return [min, max] as const;
}

function paddedDomain(min: number, max: number) {
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad] as const;
}

function ticks(min: number, max: number, count = 5) {
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

function tickLabel(value: number) {
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 10_000) return value.toExponential(1);
  return Number(value.toFixed(3)).toString();
}

function linePath(points: PlotPoint[], xScale: (value: number) => number, yScale: (value: number) => number) {
  let drawing = false;
  return points.map((point) => {
    if (point.y === null) {
      drawing = false;
      return "";
    }
    const command = drawing ? "L" : "M";
    drawing = true;
    return `${command}${xScale(point.x).toFixed(2)},${yScale(point.y).toFixed(2)}`;
  }).filter(Boolean).join(" ");
}

function sampleExpression(expression: SideChatPlotExpression, min: number, max: number, parameters: Record<string, number>) {
  return Array.from({ length: 121 }, (_, index) => {
    const x = min + ((max - min) * index) / 120;
    return { x, y: evaluateSideChatPlotExpression(expression, x, parameters) };
  });
}

function plotSeries(visual: Extract<SideChatVisualSpec, { type: "function_plot" | "line_chart" }>): RenderSeries[] {
  if (visual.type === "line_chart") return visual.series.map((series) => ({ label: series.label, points: series.points }));
  return visual.series.map((series) => ({
    label: series.label,
    points: sampleExpression(series.expression, visual.xAxis.min, visual.xAxis.max, visual.parameters || {}),
  }));
}

function annotationY(
  annotation: { x: number; y?: number },
  series: RenderSeries[],
) {
  if (annotation.y !== undefined) return annotation.y;
  const points = series[0]?.points.filter((point): point is { x: number; y: number } => point.y !== null) || [];
  return points.reduce<{ x: number; y: number } | null>((nearest, point) => (
    !nearest || Math.abs(point.x - annotation.x) < Math.abs(nearest.x - annotation.x) ? point : nearest
  ), null)?.y;
}

function PlotVisual({ visual }: { visual: Extract<SideChatVisualSpec, { type: "function_plot" | "line_chart" }> }) {
  const clipId = `side-chat-plot-clip-${useId().replace(/:/gu, "")}`;
  const series = plotSeries(visual);
  const allPoints = series.flatMap((item) => item.points).filter((point): point is { x: number; y: number } => point.y !== null);
  const inferredX = extent(allPoints.map((point) => point.x));
  const inferredY = extent(allPoints.map((point) => point.y));
  const xMin = visual.xAxis.min ?? inferredX[0];
  const xMax = visual.xAxis.max ?? inferredX[1];
  const yPadded = paddedDomain(inferredY[0], inferredY[1]);
  const yMin = visual.yAxis.min ?? yPadded[0];
  const yMax = visual.yAxis.max ?? yPadded[1];
  const plotWidth = PLOT_WIDTH - PLOT_MARGIN.left - PLOT_MARGIN.right;
  const plotHeight = PLOT_HEIGHT - PLOT_MARGIN.top - PLOT_MARGIN.bottom;
  const xScale = (value: number) => PLOT_MARGIN.left + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const yScale = (value: number) => PLOT_MARGIN.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight;
  const xTicks = ticks(xMin, xMax);
  const yTicks = ticks(yMin, yMax);

  return (
    <svg className="side-chat-plot" viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`} role="img" aria-label={visual.title}>
      <title>{visual.title}</title>
      <desc>{visual.xAxis.label}에 따른 {visual.yAxis.label} 그래프</desc>
      <defs>
        <clipPath id={clipId}>
          <rect x={PLOT_MARGIN.left} y={PLOT_MARGIN.top} width={plotWidth} height={plotHeight} />
        </clipPath>
      </defs>
      <g className="plot-legend" aria-hidden="true">
        {series.map((item, index) => {
          const x = PLOT_MARGIN.left + index * 140;
          return (
            <g key={`${item.label}-legend`} className={SERIES_CLASSES[index]}>
              <line x1={x} x2={x + 20} y1={12} y2={12} />
              <text x={x + 26} y={16}>{item.label}</text>
            </g>
          );
        })}
      </g>
      <g className="plot-grid" aria-hidden="true">
        {xTicks.map((tick) => <line key={`x-${tick}`} x1={xScale(tick)} x2={xScale(tick)} y1={PLOT_MARGIN.top} y2={PLOT_MARGIN.top + plotHeight} />)}
        {yTicks.map((tick) => <line key={`y-${tick}`} x1={PLOT_MARGIN.left} x2={PLOT_MARGIN.left + plotWidth} y1={yScale(tick)} y2={yScale(tick)} />)}
      </g>
      <g className="plot-axes" aria-hidden="true">
        <line x1={PLOT_MARGIN.left} x2={PLOT_MARGIN.left + plotWidth} y1={PLOT_MARGIN.top + plotHeight} y2={PLOT_MARGIN.top + plotHeight} />
        <line x1={PLOT_MARGIN.left} x2={PLOT_MARGIN.left} y1={PLOT_MARGIN.top} y2={PLOT_MARGIN.top + plotHeight} />
        {xTicks.map((tick) => <text key={`xt-${tick}`} x={xScale(tick)} y={PLOT_MARGIN.top + plotHeight + 24} textAnchor="middle">{tickLabel(tick)}</text>)}
        {yTicks.map((tick) => <text key={`yt-${tick}`} x={PLOT_MARGIN.left - 12} y={yScale(tick) + 4} textAnchor="end">{tickLabel(tick)}</text>)}
        <text className="axis-label" x={PLOT_MARGIN.left + plotWidth / 2} y={PLOT_HEIGHT - 12} textAnchor="middle">{visual.xAxis.label}</text>
        <text className="axis-label" transform={`translate(18 ${PLOT_MARGIN.top + plotHeight / 2}) rotate(-90)`} textAnchor="middle">{visual.yAxis.label}</text>
      </g>
      <g className="plot-series" clipPath={`url(#${clipId})`}>
        {series.map((item, index) => (
          <path
            key={`${item.label}-${index}`}
            className={SERIES_CLASSES[index]}
            d={linePath(item.points, xScale, yScale)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      <g className="plot-annotations">
        {(visual.annotations || []).map((annotation, index) => {
          const y = annotationY(annotation, series);
          if (y === undefined || annotation.x < xMin || annotation.x > xMax || y < yMin || y > yMax) return null;
          const px = xScale(annotation.x);
          const py = yScale(y);
          return (
            <g key={`${annotation.label}-${index}`}>
              <circle cx={px} cy={py} r={4} />
              <text x={Math.min(px + 8, PLOT_WIDTH - 130)} y={Math.max(py - 9, 16)}>{annotation.label}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function DiagramVisual({ visual }: { visual: Extract<SideChatVisualSpec, { type: "diagram" }> }) {
  // Same Pele layout engine as lesson diagrams; detail lines become a second label line.
  const spec = useMemo(() => sanitizeDiagramSpec(visual), [visual]);
  return spec ? <DiagramView spec={spec} label={visual.title} /> : null;
}

export function SideChatVisualRenderer({ visual: rawVisual }: { visual: SideChatVisualSpec }) {
  const visual = normalizeSideChatVisualSpec(rawVisual);
  if (!visual) return null;
  return (
    <figure className={`side-chat-visual ${visual.type}`}>
      <figcaption>{visual.title}</figcaption>
      <div className="side-chat-visual-canvas">
        {visual.type === "diagram" ? <DiagramVisual visual={visual} /> : <PlotVisual visual={visual} />}
      </div>
    </figure>
  );
}
