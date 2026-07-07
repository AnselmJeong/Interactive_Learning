import { describe, expect, test } from "bun:test";
import type { SourceFigure } from "../../shared/artifact-types";
import { shouldAutoRenderSourceFigure } from "./source-figure-filter";

function figure(overrides: Partial<SourceFigure> = {}): SourceFigure {
  return {
    id: "figure-1",
    sourceId: "source-1",
    title: "Figure from source",
    assetPath: "/tmp/figure.png",
    assetUrl: "file:///tmp/figure.png",
    mimeType: "image/png",
    caption: null,
    captionStatus: "missing",
    width: 512,
    height: 512,
    locator: "page 2",
    sourceChunkIds: ["chunk-1"],
    ...overrides,
  };
}

describe("source figure auto-render filter", () => {
  test("suppresses unlabeled icon-like figures in chat", () => {
    expect(shouldAutoRenderSourceFigure(figure())).toBe(false);
  });

  test("keeps captioned figures even when square", () => {
    expect(shouldAutoRenderSourceFigure(figure({ caption: "Figure 1. Model architecture." }))).toBe(true);
  });

  test("keeps unlabeled wide chart-like figures", () => {
    expect(shouldAutoRenderSourceFigure(figure({ width: 900, height: 420 }))).toBe(true);
  });
});
