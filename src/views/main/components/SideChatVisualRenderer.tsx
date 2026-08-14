import { useId } from "react";
import type { SideChatPlotExpression, SideChatVisualSpec } from "../../../shared/artifact-types";
import { evaluateSideChatPlotExpression, normalizeSideChatVisualSpec } from "../../../shared/side-chat-visual";

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

function diagramLayout(visual: Extract<SideChatVisualSpec, { type: "diagram" }>) {
  const nodeWidth = 164;
  const nodeHeight = 72;
  const depth = new Map(visual.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < visual.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of visual.edges) {
      const next = Math.min(visual.nodes.length - 1, (depth.get(edge.from) || 0) + 1);
      if (next > (depth.get(edge.to) || 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const usedDepths = [...new Set(depth.values())].sort((a, b) => a - b);
  const compactDepth = new Map(usedDepths.map((value, index) => [value, index]));
  const layers = new Map<number, typeof visual.nodes>();
  for (const node of visual.nodes) {
    const layer = compactDepth.get(depth.get(node.id) || 0) || 0;
    layers.set(layer, [...(layers.get(layer) || []), node]);
  }
  const layerCount = Math.max(1, layers.size);
  const maxInLayer = Math.max(...[...layers.values()].map((nodes) => nodes.length));
  const width = visual.direction === "horizontal" ? Math.max(680, layerCount * 210 + 80) : Math.max(680, maxInLayer * 190 + 80);
  const height = visual.direction === "horizontal" ? Math.max(300, maxInLayer * 104 + 80) : Math.max(300, layerCount * 108 + 80);
  const usableWidth = width - nodeWidth - 80;
  const usableHeight = height - nodeHeight - 80;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, nodes] of layers) {
    nodes.forEach((node, index) => {
      const x = visual.direction === "horizontal"
        ? 40 + (layer * usableWidth) / Math.max(1, layerCount - 1)
        : 40 + (index * usableWidth) / Math.max(1, nodes.length - 1);
      const y = visual.direction === "horizontal"
        ? 40 + (index * usableHeight) / Math.max(1, nodes.length - 1)
        : 40 + (layer * usableHeight) / Math.max(1, layerCount - 1);
      positions.set(node.id, { x, y });
    });
  }
  return { width, height, positions };
}

function wrappedLabel(value: string, max = 18) {
  const characters = Array.from(value);
  if (characters.length <= max) return [value];
  const split = value.lastIndexOf(" ", max);
  const point = split > max * 0.55 ? split : max;
  return [characters.slice(0, point).join("").trim(), characters.slice(point).join("").trim()].filter(Boolean).slice(0, 2);
}

function DiagramVisual({ visual }: { visual: Extract<SideChatVisualSpec, { type: "diagram" }> }) {
  const markerId = `side-chat-arrow-${useId().replace(/:/gu, "")}`;
  const { width, height, positions } = diagramLayout(visual);
  const nodeWidth = 164;
  const nodeHeight = 72;

  return (
    <svg className="side-chat-diagram" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={visual.title}>
      <title>{visual.title}</title>
      <desc>{visual.nodes.map((node) => node.label).join(", ")} 사이의 관계도</desc>
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <g className="diagram-edges">
        {visual.edges.map((edge, index) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const horizontal = visual.direction === "horizontal";
          const x1 = from.x + (horizontal ? nodeWidth : nodeWidth / 2);
          const y1 = from.y + (horizontal ? nodeHeight / 2 : nodeHeight);
          const x2 = to.x + (horizontal ? 0 : nodeWidth / 2);
          const y2 = to.y + (horizontal ? nodeHeight / 2 : 0);
          const path = horizontal
            ? `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <path d={path} markerEnd={`url(#${markerId})`} vectorEffect="non-scaling-stroke" />
              {edge.label ? <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle">{edge.label}</text> : null}
            </g>
          );
        })}
      </g>
      <g className="diagram-nodes">
        {visual.nodes.map((node) => {
          const position = positions.get(node.id)!;
          const lines = wrappedLabel(node.label);
          return (
            <g key={node.id} className={`diagram-node ${node.tone || "default"}`} transform={`translate(${position.x} ${position.y})`}>
              <rect width={nodeWidth} height={nodeHeight} rx={10} />
              <text className="diagram-node-label" x={nodeWidth / 2} y={lines.length > 1 ? 24 : 31} textAnchor="middle">
                {lines.map((line, index) => <tspan key={line} x={nodeWidth / 2} dy={index === 0 ? 0 : 17}>{line}</tspan>)}
              </text>
              {node.detail ? <text className="diagram-node-detail" x={nodeWidth / 2} y={60} textAnchor="middle">{wrappedLabel(node.detail, 24)[0]}</text> : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
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
