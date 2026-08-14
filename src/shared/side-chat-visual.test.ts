import { describe, expect, test } from "bun:test";
import type { SideChatPlotExpression } from "./artifact-types";
import {
  evaluateSideChatPlotExpression,
  isSideChatVisualizationRequest,
  normalizeSideChatVisualSpec,
} from "./side-chat-visual";

describe("side-chat visualization requests", () => {
  test("recognizes explicit Korean and English visualization requests", () => {
    expect(isSideChatVisualizationRequest("이 식을 그래프로 보여줘")).toBe(true);
    expect(isSideChatVisualizationRequest("이 관계를 시각화해줘")).toBe(true);
    expect(isSideChatVisualizationRequest("diagram으로 그려줘")).toBe(true);
    expect(isSideChatVisualizationRequest("이 과정을 그림으로 표현해줘")).toBe(true);
    expect(isSideChatVisualizationRequest("이 관계를 도식화해줘")).toBe(true);
    expect(isSideChatVisualizationRequest("Plot this function as a graph")).toBe(true);
    expect(isSideChatVisualizationRequest("Show this as a chart")).toBe(true);
  });

  test("does not route ordinary explanations through visual JSON", () => {
    expect(isSideChatVisualizationRequest("이 식이 무엇을 뜻하는지 설명해줘")).toBe(false);
    expect(isSideChatVisualizationRequest("그래프라는 말의 뜻은 무엇이야?")).toBe(false);
    expect(isSideChatVisualizationRequest("What is a diagram?")).toBe(false);
  });

  test("recognizes a revision when the thread already has a visual", () => {
    expect(isSideChatVisualizationRequest("람다를 2로 바꿔줘", [{ visual: { type: "function_plot" } }])).toBe(true);
  });
});

describe("side-chat visual validation and evaluation", () => {
  const exponential: SideChatPlotExpression = {
    op: "multiply",
    left: { op: "parameter", name: "lambda" },
    right: {
      op: "exp",
      value: {
        op: "negate",
        value: {
          op: "multiply",
          left: { op: "parameter", name: "lambda" },
          right: { op: "x" },
        },
      },
    },
  };

  test("evaluates a validated exponential density deterministically", () => {
    expect(evaluateSideChatPlotExpression(exponential, 0, { lambda: 1 })).toBe(1);
    expect(evaluateSideChatPlotExpression(exponential, 1, { lambda: 1 })).toBeCloseTo(Math.E ** -1);
  });

  test("accepts a bounded function plot", () => {
    const visual = normalizeSideChatVisualSpec({
      type: "function_plot",
      title: "지수분포의 확률밀도",
      xAxis: { label: "ISI", min: 0, max: 5 },
      yAxis: { label: "p(ISI)", min: 0, max: 1 },
      parameters: { lambda: 1 },
      series: [{ label: "λ = 1", expression: exponential }],
      annotations: [{ x: 0, y: 1, label: "최댓값" }],
    });

    expect(visual?.type).toBe("function_plot");
    expect(visual && visual.type === "function_plot" ? visual.series[0]?.label : "").toBe("λ = 1");
  });

  test("rejects unknown operations and diagram edges to missing nodes", () => {
    expect(normalizeSideChatVisualSpec({
      type: "function_plot",
      title: "unsafe",
      xAxis: { label: "x", min: 0, max: 1 },
      yAxis: { label: "y" },
      series: [{ label: "bad", expression: { op: "eval", value: "alert(1)" } }],
    })).toBeNull();

    expect(normalizeSideChatVisualSpec({
      type: "function_plot",
      title: "정의역 밖의 로그",
      xAxis: { label: "x", min: -5, max: -1 },
      yAxis: { label: "y" },
      series: [{ label: "log(x)", expression: { op: "log", value: { op: "x" } } }],
    })).toBeNull();

    expect(normalizeSideChatVisualSpec({
      type: "diagram",
      title: "broken",
      direction: "horizontal",
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "missing" }],
    })).toBeNull();
  });
});
