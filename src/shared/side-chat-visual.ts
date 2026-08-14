import type { SideChatPlotExpression, SideChatVisualSpec } from "./artifact-types";

const MAX_ABS_NUMBER = 1_000_000_000;
const MAX_EXPRESSION_DEPTH = 12;
const MAX_EXPRESSION_NODES = 64;
const MAX_PARAMETERS = 8;
const MAX_SERIES = 4;
const MAX_POINTS_PER_SERIES = 160;
const MAX_ANNOTATIONS = 10;
const MAX_DIAGRAM_NODES = 12;
const MAX_DIAGRAM_EDGES = 20;

const VISUAL_SUBJECT = /(그래프|시각화|다이어그램|diagram|graph|plot|chart|도식|도표|그림|관계도|흐름도|순서도|구조도|개념도|좌표축|곡선|visualization)/iu;
const VISUAL_ACTION = /(보여|그려|만들|표현|나타내|시각화|도식화|show|draw|make|create|render|display|illustrate|represent|visuali[sz]e)/iu;
const DIRECT_VISUAL_REQUEST = /(그려\s*줘|그려\s*주세요|그림으로\s*(?:보여|표현)|(?:draw|plot|chart|diagram|visuali[sz]e)\s+(?:this|it|the\b))/iu;
const VISUAL_REVISION = /(바꿔|변경|수정|조정|다시|추가|제거|빼|확대|축소|비교|겹쳐|update|change|revise|add|remove)/iu;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text && text.length <= max ? text : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_NUMBER ? value : null;
}

function optionalFiniteNumber(value: unknown) {
  return value === undefined ? undefined : finiteNumber(value);
}

function normalizeAxis(value: unknown, requireDomain: boolean) {
  const axis = record(value);
  if (!axis) return null;
  const label = boundedText(axis.label, 80);
  if (!label) return null;
  const min = optionalFiniteNumber(axis.min);
  const max = optionalFiniteNumber(axis.max);
  if (min === null || max === null) return null;
  if (requireDomain && (min === undefined || max === undefined)) return null;
  if ((min === undefined) !== (max === undefined)) return null;
  if (min !== undefined && max !== undefined && min >= max) return null;
  return { label, ...(min !== undefined ? { min, max: max! } : {}) };
}

function normalizeExpression(
  value: unknown,
  parameterNames: Set<string>,
  state: { nodes: number },
  depth = 0,
): SideChatPlotExpression | null {
  if (depth > MAX_EXPRESSION_DEPTH || state.nodes >= MAX_EXPRESSION_NODES) return null;
  const expression = record(value);
  if (!expression || typeof expression.op !== "string") return null;
  state.nodes += 1;

  if (expression.op === "x") return { op: "x" };
  if (expression.op === "number") {
    const number = finiteNumber(expression.value);
    return number === null ? null : { op: "number", value: number };
  }
  if (expression.op === "parameter") {
    const name = boundedText(expression.name, 40);
    return name && parameterNames.has(name) ? { op: "parameter", name } : null;
  }
  if (["negate", "abs", "sqrt", "exp", "log", "sin", "cos", "tan"].includes(expression.op)) {
    const operand = normalizeExpression(expression.value, parameterNames, state, depth + 1);
    return operand ? { op: expression.op as "negate" | "abs" | "sqrt" | "exp" | "log" | "sin" | "cos" | "tan", value: operand } : null;
  }
  if (["add", "subtract", "multiply", "divide", "power", "min", "max"].includes(expression.op)) {
    const left = normalizeExpression(expression.left, parameterNames, state, depth + 1);
    const right = normalizeExpression(expression.right, parameterNames, state, depth + 1);
    return left && right
      ? { op: expression.op as "add" | "subtract" | "multiply" | "divide" | "power" | "min" | "max", left, right }
      : null;
  }
  return null;
}

function normalizeAnnotations(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS) return null;
  const annotations: Array<{ x: number; y?: number; label: string }> = [];
  for (const item of value) {
    const annotation = record(item);
    if (!annotation) return null;
    const x = finiteNumber(annotation.x);
    const y = optionalFiniteNumber(annotation.y);
    const label = boundedText(annotation.label, 100);
    if (x === null || y === null || !label) return null;
    annotations.push({ x, ...(y !== undefined ? { y } : {}), label });
  }
  return annotations;
}

function normalizeParameters(value: unknown) {
  if (value === undefined) return {};
  const input = record(value);
  if (!input || Object.keys(input).length > MAX_PARAMETERS) return null;
  const parameters: Record<string, number> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(name)) return null;
    const number = finiteNumber(raw);
    if (number === null) return null;
    parameters[name] = number;
  }
  return parameters;
}

export function normalizeSideChatVisualSpec(value: unknown): SideChatVisualSpec | null {
  const visual = record(value);
  if (!visual) return null;
  const title = boundedText(visual.title, 180);
  if (!title) return null;

  if (visual.type === "function_plot") {
    const xAxis = normalizeAxis(visual.xAxis, true);
    const yAxis = normalizeAxis(visual.yAxis, false);
    const parameters = normalizeParameters(visual.parameters);
    const annotations = normalizeAnnotations(visual.annotations);
    if (!xAxis || !yAxis || !parameters || annotations === null || !Array.isArray(visual.series) || !visual.series.length || visual.series.length > MAX_SERIES) return null;
    const functionXAxis = xAxis as { label: string; min: number; max: number };
    const parameterNames = new Set(Object.keys(parameters));
    const series: Extract<SideChatVisualSpec, { type: "function_plot" }>["series"] = [];
    for (const rawSeries of visual.series) {
      const item = record(rawSeries);
      const label = boundedText(item?.label, 80);
      const expression = item ? normalizeExpression(item.expression, parameterNames, { nodes: 0 }) : null;
      if (!label || !expression) return null;
      const samples = Array.from({ length: 17 }, (_, index) => {
        const x = functionXAxis.min + ((functionXAxis.max - functionXAxis.min) * index) / 16;
        return evaluateSideChatPlotExpression(expression, x, parameters);
      }).filter((sample): sample is number => sample !== null);
      if (samples.length < 2) return null;
      if (yAxis.min !== undefined && yAxis.max !== undefined && !samples.some((sample) => sample >= yAxis.min! && sample <= yAxis.max!)) return null;
      series.push({ label, expression });
    }
    return {
      type: "function_plot",
      title,
      xAxis: functionXAxis,
      yAxis,
      ...(Object.keys(parameters).length ? { parameters } : {}),
      series,
      ...(annotations?.length ? { annotations } : {}),
    };
  }

  if (visual.type === "line_chart") {
    const xAxis = normalizeAxis(visual.xAxis, false);
    const yAxis = normalizeAxis(visual.yAxis, false);
    const annotations = normalizeAnnotations(visual.annotations);
    if (!xAxis || !yAxis || annotations === null || !Array.isArray(visual.series) || !visual.series.length || visual.series.length > MAX_SERIES) return null;
    const series: Extract<SideChatVisualSpec, { type: "line_chart" }>["series"] = [];
    for (const rawSeries of visual.series) {
      const item = record(rawSeries);
      const label = boundedText(item?.label, 80);
      if (!label || !Array.isArray(item?.points) || item.points.length < 2 || item.points.length > MAX_POINTS_PER_SERIES) return null;
      const points: Array<{ x: number; y: number }> = [];
      for (const rawPoint of item.points) {
        const point = record(rawPoint);
        const x = finiteNumber(point?.x);
        const y = finiteNumber(point?.y);
        if (x === null || y === null) return null;
        points.push({ x, y });
      }
      series.push({ label, points });
    }
    return { type: "line_chart", title, xAxis, yAxis, series, ...(annotations?.length ? { annotations } : {}) };
  }

  if (visual.type === "diagram") {
    if ((visual.direction !== "horizontal" && visual.direction !== "vertical") || !Array.isArray(visual.nodes) || !visual.nodes.length || visual.nodes.length > MAX_DIAGRAM_NODES || !Array.isArray(visual.edges) || visual.edges.length > MAX_DIAGRAM_EDGES) return null;
    const nodes: Extract<SideChatVisualSpec, { type: "diagram" }>["nodes"] = [];
    const nodeIds = new Set<string>();
    for (const rawNode of visual.nodes) {
      const node = record(rawNode);
      const id = boundedText(node?.id, 40);
      const label = boundedText(node?.label, 100);
      const detail = node?.detail === undefined ? undefined : boundedText(node.detail, 180);
      const tone = node?.tone === undefined ? undefined : node.tone;
      if (!id || !/^[A-Za-z0-9_-]+$/u.test(id) || nodeIds.has(id) || !label || detail === null || (tone !== undefined && tone !== "default" && tone !== "accent" && tone !== "muted")) return null;
      nodeIds.add(id);
      nodes.push({ id, label, ...(detail ? { detail } : {}), ...(tone ? { tone } : {}) });
    }
    const edges: Extract<SideChatVisualSpec, { type: "diagram" }>["edges"] = [];
    for (const rawEdge of visual.edges) {
      const edge = record(rawEdge);
      const from = boundedText(edge?.from, 40);
      const to = boundedText(edge?.to, 40);
      const label = edge?.label === undefined ? undefined : boundedText(edge.label, 80);
      if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to) || label === null) return null;
      edges.push({ from, to, ...(label ? { label } : {}) });
    }
    return { type: "diagram", title, direction: visual.direction, nodes, edges };
  }

  return null;
}

export function isSideChatVisualizationRequest(question: string, history: Array<{ visual?: unknown }> = []) {
  const normalized = question.replace(/\s+/gu, " ").trim();
  if (!normalized) return false;
  if (DIRECT_VISUAL_REQUEST.test(normalized)) return true;
  if (VISUAL_SUBJECT.test(normalized) && VISUAL_ACTION.test(normalized)) return true;
  return history.some((message) => Boolean(message.visual)) && VISUAL_REVISION.test(normalized);
}

export function evaluateSideChatPlotExpression(
  expression: SideChatPlotExpression,
  x: number,
  parameters: Record<string, number> = {},
): number | null {
  function evaluate(node: SideChatPlotExpression): number {
    if (node.op === "x") return x;
    if (node.op === "number") return node.value;
    if (node.op === "parameter") return parameters[node.name] ?? Number.NaN;
    if (node.op === "negate") return -evaluate(node.value);
    if (node.op === "abs") return Math.abs(evaluate(node.value));
    if (node.op === "sqrt") return Math.sqrt(evaluate(node.value));
    if (node.op === "exp") return Math.exp(evaluate(node.value));
    if (node.op === "log") return Math.log(evaluate(node.value));
    if (node.op === "sin") return Math.sin(evaluate(node.value));
    if (node.op === "cos") return Math.cos(evaluate(node.value));
    if (node.op === "tan") return Math.tan(evaluate(node.value));
    if (!("left" in node) || !("right" in node)) return Number.NaN;
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    if (node.op === "add") return left + right;
    if (node.op === "subtract") return left - right;
    if (node.op === "multiply") return left * right;
    if (node.op === "divide") return right === 0 ? Number.NaN : left / right;
    if (node.op === "power") return left ** right;
    if (node.op === "min") return Math.min(left, right);
    return Math.max(left, right);
  }

  const result = evaluate(expression);
  return Number.isFinite(result) && Math.abs(result) <= MAX_ABS_NUMBER ? result : null;
}
