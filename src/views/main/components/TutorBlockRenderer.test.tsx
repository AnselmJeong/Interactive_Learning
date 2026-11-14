import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceFigure } from "../../../shared/artifact-types";
import type { SourceRef } from "../../../shared/tutor-types";
import type { TutorContentBlock } from "../../../shared/tutor-types";
import { TutorBlockRenderer } from "./TutorBlockRenderer";
import { normalizeDiagramBlock } from "../../../shared/diagram-spec";

describe("TutorBlockRenderer regressions", () => {
  test("renders an HTML lesson's repeated outer and opening title only once", () => {
    const blocks: TutorContentBlock[] = [{ type: "rich_html", title: "2.1 Introduction", body: "An explanation.", html: '<article><h2>2.1 INTRODUCTION</h2><p>An explanation.</p><h3>2.2 Next section</h3></article>' }];
    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));
    expect(html.match(/2\.1 Introduction/gi)).toHaveLength(1);
    expect(html).toContain("An explanation.");
    expect(html).toContain("2.2 Next section");
  });

  test("lays out a structured diagram block with SVG math labels", () => {
    const block = normalizeDiagramBlock({
      type: "diagram",
      title: "EEG가 잡히는 원리",
      caption: "화살표는 $n$개 세포 신호의 전달 순서다.",
      direction: "TD",
      nodes: [{ id: "a", label: "동기화된 활성화" }, { id: "b", label: "전기장 합산 $\\sum_i E_i$", tone: "accent" }],
      edges: [{ from: "a", to: "b" }],
    })!;
    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks: [block] }));
    expect(html).toContain("<h4>EEG가 잡히는 원리</h4>");
    expect(html).toContain("pele-flowchart");
    expect(html).toContain("learn-accent");
    // Node math is self-contained SVG (WebKit mis-places KaTeX HTML inside foreignObject); the caption stays KaTeX.
    expect(html).toContain('<svg class="pele-math"');
    expect(html).not.toContain("foreignObject");
    expect(html.match(/class="katex"/g)?.length).toBe(1);
  });

  test("cleans duplicate title paths in saved structured lessons without removing separate sections", () => {
    const blocks: TutorContentBlock[] = [
      { type: "bullets", title: "1. Introduction › 1 Introduction", items: ["First"] },
      { type: "flow", title: "2. Introduction", steps: ["Second"] },
    ];
    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));
    expect(html).toContain("<h4>1. Introduction</h4>");
    expect(html).toContain("<h4>2. Introduction</h4>");
    expect(html).not.toContain("›");
  });
  test("renders a rich explanation and its evidence with passive diagrams and disclosures", () => {
    const blocks: TutorContentBlock[] = [{ type: "rich_html", title: "A relationship", body: "Explanation", html: '<div class="learn-compare"><section><h4>Before</h4><p>A</p></section><section><h4>After</h4><p>B</p></section></div><details><summary>Reason</summary><p>More detail</p></details><script>bad()</script>', grounding: { status: "interpretation", evidence: [] } }];
    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));
    expect(html).toContain('class="learn-compare"');
    expect(html).toContain('<summary>Reason</summary>');
    expect(html).not.toContain('해석적 재구성');
    expect(html).not.toContain('bad()');
  });
  test("omits an extracted figure-caption prefix from guided reading", () => {
    const blocks: TutorContentBlock[] = [{
      type: "guided_reading",
      sourceRef: "chunk-020",
      body: "| | | Figure 4 : Example decision problem (color perception). A good general introduction to Bayesian decision theory follows.",
    }];

    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));

    expect(html).not.toContain("Figure 4");
    expect(html).not.toContain("Example decision problem");
    expect(html).toContain("A good general introduction");
  });

  test("repairs a legacy display equation split into a flow at math pipes", () => {
    const blocks: TutorContentBlock[] = [{
      type: "flow",
      title: "$$p(s",
      steps: [String.raw`x) = \frac{p(x`, String.raw`s)\,p(s)}{p(x)}$$`],
    }];

    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));

    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain("flow-block");
    expect(html).not.toContain("<ol>");
  });

  test("keeps a complete display equation with conditional-probability pipes as prose", () => {
    const blocks: TutorContentBlock[] = [{
      type: "paragraph",
      body: String.raw`$$p(s|x) = \frac{p(x|s)\,p(s)}{p(x)}$$`,
    }];

    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, { blocks }));

    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain("flow-block");
    expect(html).not.toContain("<ol>");
  });

  test("renders a numbered figure mentioned by a message even when another chunk owns the asset", () => {
    const figure: SourceFigure = {
      id: "source-1-figure-4",
      sourceId: "source-1",
      title: "Figure 4",
      assetPath: "/tmp/figure-4.png",
      assetUrl: "file:///tmp/figure-4.png",
      mimeType: "image/png",
      caption: null,
      captionStatus: "missing",
      width: 498,
      height: 115,
      locator: "page 5",
      sourceChunkIds: ["source-1-chunk-014", "source-1-chunk-019"],
    };
    const ownerRef: SourceRef = {
      chunkId: "source-1-chunk-014",
      title: "Earlier decision theory",
      locator: "page 5",
      text: "",
      figures: [figure],
    };
    const messageRef: SourceRef = {
      chunkId: "source-1-chunk-020",
      title: "The optimal policy",
      locator: "before section 1.3",
      text: "Figure 4: Example decision problem (color perception).",
      figures: [],
    };
    const blocks: TutorContentBlock[] = [
      { type: "bridge", body: "이제 색 지각 문제(Figure 4)에 그 구조를 대입해 봅니다." },
      {
        type: "guided_reading",
        sourceRef: messageRef.chunkId,
        body: "Figure 4는 색 지각을 결정 문제로 본 예입니다.",
      },
    ];
    const sourceRefById = new Map([
      [ownerRef.chunkId, ownerRef],
      [messageRef.chunkId, messageRef],
      ["source-2-chunk-001", {
        chunkId: "source-2-chunk-001",
        title: "Another source",
        locator: "page 1",
        text: "Figure 4 belongs to a different source.",
        figures: [{
          ...figure,
          id: "source-2-figure-4",
          sourceId: "source-2",
          title: "Figure 4 from another source",
          sourceChunkIds: ["source-2-chunk-001"],
        }],
      }],
    ]);

    const html = renderToStaticMarkup(createElement(TutorBlockRenderer, {
      blocks,
      sourceRefById,
      fallbackSourceRefs: [messageRef],
      materialId: "material-1",
      request: async () => ({}),
    }));

    expect(html.match(/class="source-figure-card compact"/g)).toHaveLength(1);
    expect(html).toContain("그림 파일을 불러오는 중입니다.");
    expect(html).toContain("<p>Figure 4</p>");
    expect(html).not.toContain("Figure 4 from another source");
  });
});
