import { describe, expect, test } from "bun:test";
import { render } from "pele";
import { diagramPlainText, diagramToMermaid, mermaidLabel, normalizeDiagramBlock, sanitizeDiagramSpec } from "./diagram-spec";

const eeg = {
  type: "diagram",
  title: "EEG가 잡히는 원리",
  direction: "TD",
  nodes: [
    { id: "sync", label: "피질 피라미드세포 수백~수십만 개가\n동시에(동기화되어) 활성화" },
    { id: "sum", label: "개별 세포의 전기장 $E=\\sum_i E_i$ 합산" },
    { id: "eeg", label: "두피 전극이 기록 → EEG", tone: "accent" },
    { id: "limits", label: "· 작은 집단의 동기화 활동\n· 비동기(asynchronous) 활동", shape: "note" },
  ],
  edges: [
    { from: "sync", to: "sum" },
    { from: "sum", to: "eeg", label: "두피까지 전달" },
  ],
  groups: [{ label: "EEG로 측정이 어려운 활동", nodes: ["limits"], style: "dashed" }],
};

describe("diagram spec", () => {
  test("sanitizes ids, drops dangling edges and unknown values", () => {
    const spec = sanitizeDiagramSpec({
      direction: "horizontal",
      nodes: [{ id: "x", label: "A", tone: "loud" }, { id: "y", label: "B", shape: "round" }, { id: "x", label: "dup" }],
      edges: [{ from: "x", to: "y", style: "dotted" }, { from: "x", to: "missing" }, { source: "y", target: "x", style: "dashed" }],
    });
    expect(spec).toEqual({
      direction: "LR",
      nodes: [{ id: "n1", label: "A" }, { id: "n2", label: "B", shape: "round" }],
      edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n1", style: "dashed" }],
    });
  });

  test("rejects graphs without structure", () => {
    expect(sanitizeDiagramSpec({ nodes: [{ id: "a", label: "only" }], edges: [] })).toBeNull();
    expect(sanitizeDiagramSpec({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] })).toBeNull();
    expect(sanitizeDiagramSpec("flowchart TD; A-->B")).toBeNull();
  });

  test("escapes Mermaid syntax but keeps math", () => {
    expect(mermaidLabel('a "b" <c> & #1 costs $5 [x]')).toBe("a #quot;b#quot; #lt;c#gt; #amp; #35;1 costs #36;5 [x]");
    expect(mermaidLabel("합 $\\sum_i x_i$\n둘째 줄")).toBe("합 $$\\sum_i x_i$$<br/>둘째 줄");
    expect(mermaidLabel("\\(a<b\\) and $$c$$")).toBe("$$a<b$$ and $$c$$");
  });

  test("compiles to Mermaid that Pele renders, with math through the resolver", () => {
    const block = normalizeDiagramBlock(eeg)!;
    expect(block.body).toContain("→ (두피까지 전달)");
    const source = diagramToMermaid(block);
    expect(source).toContain("\nflowchart TD\n");
    expect(source).toContain("n3 ~~~ n4");
    expect(source).toContain('subgraph g1["EEG로 측정이 어려운 활동"]');
    expect(source).toContain("class n3 learn-accent");
    expect(source).toContain("class g1 learn-dashed");
    const maths: string[] = [];
    const result = render(source, { math: (tex, size) => (maths.push(tex), { html: "<span>m</span>", width: 30, height: size }) });
    expect(maths).toEqual(["E=\\sum_i E_i"]);
    expect(result.svg).toContain("pele-node pele-shape-rect learn-accent");
    expect(result.svg).toContain("동시에(동기화되어) 활성화");
    expect(result.svg).toContain("pele-cluster learn-dashed");
  });

  test("hostile labels cannot inject Mermaid statements or markup", () => {
    const spec = sanitizeDiagramSpec({
      nodes: [{ id: "a", label: 'x"]\nclick a "javascript:alert(1)"' }, { id: "b", label: "<script>alert(1)</script>" }],
      edges: [{ from: "a", to: "b", label: '|"] --> c' }],
    })!;
    const source = diagramToMermaid(spec);
    expect(source.split("\n").filter((line) => line.trim().startsWith("click"))).toEqual([]);
    const { svg } = render(source);
    expect(svg).not.toContain("<script");
    // Hostile text stays inert label text: no links, no extra edges.
    expect(svg).not.toMatch(/<a\b|href=/);
    expect(svg.match(/class="pele-edge"/g)?.length).toBe(1);
  });

  test("plain text keeps unconnected group members", () => {
    const text = diagramPlainText(sanitizeDiagramSpec(eeg)!);
    expect(text).toContain("EEG로 측정이 어려운 활동\n· 작은 집단의 동기화 활동 · 비동기(asynchronous) 활동");
  });
});
