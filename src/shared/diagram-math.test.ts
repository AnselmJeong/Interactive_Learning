import { describe, expect, test } from "bun:test";
import { render } from "pele";
import { renderDiagramMath } from "./diagram-math";
import { diagramToMermaid, sanitizeDiagramSpec } from "./diagram-spec";

describe("diagram math", () => {
  test("renders TeX as standalone SVG sized from its viewBox", () => {
    const small = renderDiagramMath("2f_{\\max}", 16)!;
    const large = renderDiagramMath("2f_{\\max}", 32)!;
    expect(small.svg).toStartWith("<svg");
    expect(small.svg).toContain("<path");
    expect(small.svg).not.toContain("<span");
    expect(small.width).toBeGreaterThan(20);
    expect(small.height).toBeGreaterThan(10);
    expect(large.width).toBeCloseTo(small.width * 2, 1);
    expect(renderDiagramMath("\\frac{f_s}{2}", 16)!.height).toBeGreaterThan(small.height);
  });

  test("several formulas in one label get their own width and never overlap", () => {
    const spec = sanitizeDiagramSpec({
      direction: "LR",
      nodes: [{ id: "a", label: "표본화 $f_s$" }, { id: "b", label: "$2f_{\\max}$ 와 $f_s/2$ 비교" }],
      edges: [{ from: "a", to: "b", label: "$f_s \\ge 2f_{\\max}$" }],
    })!;
    const { svg } = render(diagramToMermaid(spec), { math: renderDiagramMath });
    expect(svg).not.toContain("foreignObject");
    const boxes = [...svg.matchAll(/<svg class="pele-math" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    expect(boxes).toHaveLength(4);
    // The two formulas of node b sit on one line: the second starts after the first ends.
    const node = svg.slice(svg.indexOf('data-id="n2"'));
    const [first, second] = [...node.matchAll(/<svg class="pele-math" x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(second![0]!).toBeGreaterThanOrEqual(first![0]! + first![1]!);
  });
});
