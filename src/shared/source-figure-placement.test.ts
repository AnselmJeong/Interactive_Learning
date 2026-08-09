import { describe, expect, test } from "bun:test";
import { canonicalFigureChunkId, groupFiguresByCanonicalChunk } from "./source-figure-placement";

describe("source figure placement", () => {
  test("renders a figure only at its canonical reading-order chunk", () => {
    const figure = { id: "figure-later", sourceChunkIds: ["chunk-later", "chunk-first"] };
    const grouped = groupFiguresByCanonicalChunk([figure], ["chunk-first", "chunk-later"]);

    expect(grouped.get("chunk-first")).toBeUndefined();
    expect(grouped.get("chunk-later")).toEqual([figure]);
  });

  test("skips stale ids when finding the canonical chunk", () => {
    expect(canonicalFigureChunkId(
      { sourceChunkIds: ["removed", "chunk-live"] },
      new Set(["chunk-live"])
    )).toBe("chunk-live");
  });
});
