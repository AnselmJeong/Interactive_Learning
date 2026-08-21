import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceFigure } from "../../../shared/artifact-types";
import type { SourceRef } from "../../../shared/tutor-types";
import type { TutorContentBlock } from "../../../shared/tutor-types";
import { TutorBlockRenderer } from "./TutorBlockRenderer";

describe("TutorBlockRenderer regressions", () => {
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
