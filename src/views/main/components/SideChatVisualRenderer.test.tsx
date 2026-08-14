import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SideChatVisualSpec } from "../../../shared/artifact-types";
import { SideChatVisualRenderer } from "./SideChatVisualRenderer";

describe("SideChatVisualRenderer", () => {
  test("renders a computed function plot with axes, legend, and annotation", () => {
    const visual: SideChatVisualSpec = {
      type: "function_plot",
      title: "지수분포",
      xAxis: { label: "ISI", min: 0, max: 5 },
      yAxis: { label: "p(ISI)", min: 0, max: 1 },
      parameters: { lambda: 1 },
      series: [{
        label: "λ = 1",
        expression: {
          op: "multiply",
          left: { op: "parameter", name: "lambda" },
          right: { op: "exp", value: { op: "negate", value: { op: "multiply", left: { op: "parameter", name: "lambda" }, right: { op: "x" } } } },
        },
      }],
      annotations: [{ x: 0, y: 1, label: "최댓값" }],
    };

    const html = renderToStaticMarkup(createElement(SideChatVisualRenderer, { visual }));
    expect(html).toContain("지수분포");
    expect(html).toContain("ISI");
    expect(html).toContain("p(ISI)");
    expect(html).toContain("λ = 1");
    expect(html).toContain("최댓값");
    expect(html).toMatch(/<path[^>]+d="M[^\"]+L/);
    expect(html).not.toContain("NaN");
  });

  test("renders a bounded node-edge diagram", () => {
    const visual: SideChatVisualSpec = {
      type: "diagram",
      title: "발화 과정",
      direction: "horizontal",
      nodes: [
        { id: "input", label: "입력 전류", tone: "muted" },
        { id: "charge", label: "막전위 충전", tone: "default" },
        { id: "spike", label: "임계값과 스파이크", tone: "accent" },
      ],
      edges: [
        { from: "input", to: "charge", label: "충전" },
        { from: "charge", to: "spike", label: "도달" },
      ],
    };

    const html = renderToStaticMarkup(createElement(SideChatVisualRenderer, { visual }));
    expect(html).toContain("발화 과정");
    expect(html).toContain("입력 전류");
    expect(html).toContain("막전위 충전");
    expect(html).toContain("임계값과 스파이크");
    expect(html).toContain("marker-end");
    expect(html).not.toContain("missing");
  });
});
