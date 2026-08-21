import { describe, expect, test } from "bun:test";
import type { SourceFigure } from "../../shared/artifact-types";
import { numberedFigureReferences, sourceFiguresReferencedByText } from "./source-figure-reference";

function figure(id: string, title: string, caption: string | null = null): SourceFigure {
  return {
    id,
    sourceId: "source-1",
    title,
    assetPath: `/tmp/${id}.png`,
    assetUrl: `file:///tmp/${id}.png`,
    mimeType: "image/png",
    caption,
    captionStatus: caption ? "found" : "missing",
    width: 498,
    height: 115,
    locator: "page 5",
    sourceChunkIds: ["source-1-chunk-014"],
  };
}

describe("numbered source figure references", () => {
  test("recognizes English and Korean figure references without prefix collisions", () => {
    expect(numberedFigureReferences("Figure 4, Fig. 4.1, 그림 04")).toEqual(["4", "4.1", "4"]);
    expect(sourceFiguresReferencedByText("Figure 40을 봅니다.", [figure("four", "Figure 4")])).toEqual([]);
  });

  test("matches a tutor reference against either the figure title or caption", () => {
    const figures = [
      figure("four", "Figure 4"),
      figure("five", "Extracted image", "Fig. 5. Neuron structure"),
    ];

    expect(sourceFiguresReferencedByText("이제 Figure 4의 구조를 봅니다.", figures)).toEqual([figures[0]!]);
    expect(sourceFiguresReferencedByText("그림 5를 함께 읽습니다.", figures)).toEqual([figures[1]!]);
  });
});
