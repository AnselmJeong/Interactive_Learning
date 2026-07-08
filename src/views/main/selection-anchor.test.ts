import { describe, expect, test } from "bun:test";
import type { MaterialAnnotation, TextSelectionAnchor } from "../../shared/artifact-types";
import { findTextMatches, resolveTextSelectionAnchor } from "./selection-anchor";

function annotationWithAnchor(anchor: TextSelectionAnchor): MaterialAnnotation {
  return {
    id: "annotation-1",
    projectId: "project-1",
    materialId: "material-1",
    sourceId: null,
    chunkId: anchor.chunkId,
    surface: anchor.surface,
    anchorMessageId: anchor.messageId,
    anchorBlockId: anchor.blockId,
    textAnchor: anchor,
    kind: "lookup",
    selectedText: anchor.selectedText,
    normalizedText: anchor.normalizedText,
    result: {
      kind: "lookup",
      title: "Lookup",
      body: "Body",
      query: anchor.selectedText,
      provider: "wikipedia",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      sourceMeta: [],
    },
    sourceMeta: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeRoot(textContent: string) {
  return { textContent } as HTMLElement;
}

describe("selection anchor text matching", () => {
  test("finds repeated exact matches in order", () => {
    expect(findTextMatches("alpha beta alpha beta", "alpha beta")).toEqual([
      { startOffset: 0, endOffset: 10 },
      { startOffset: 11, endOffset: 21 },
    ]);
  });

  test("matches selected text across collapsed whitespace", () => {
    expect(findTextMatches("alpha   beta and alpha beta", "alpha beta")).toEqual([
      { startOffset: 0, endOffset: 12 },
      { startOffset: 17, endOffset: 27 },
    ]);
  });

  test("resolves the stored occurrence instead of the first repeated phrase", () => {
    const anchor: TextSelectionAnchor = {
      version: 1,
      surface: "source",
      scope: "source-chunk",
      chunkId: "chunk-1",
      selectedText: "alpha beta",
      normalizedText: "alpha beta",
      occurrence: 1,
      startOffset: 11,
      endOffset: 21,
      prefix: "",
      suffix: "",
      scopeTextLength: 21,
    };

    const resolved = resolveTextSelectionAnchor({
      root: fakeRoot("alpha beta alpha beta"),
      annotation: annotationWithAnchor(anchor),
    });

    expect(resolved?.startOffset).toBe(11);
    expect(resolved?.endOffset).toBe(21);
    expect(resolved?.text).toBe("alpha beta");
  });

  test("falls back to the first match for legacy annotations without anchor_json", () => {
    const annotation = annotationWithAnchor({
      version: 1,
      surface: "source",
      scope: "source-chunk",
      chunkId: "chunk-1",
      selectedText: "alpha beta",
      normalizedText: "alpha beta",
      occurrence: 1,
      startOffset: 11,
      endOffset: 21,
      prefix: "",
      suffix: "",
      scopeTextLength: 21,
    });
    annotation.textAnchor = null;

    const resolved = resolveTextSelectionAnchor({
      root: fakeRoot("alpha beta alpha beta"),
      annotation,
    });

    expect(resolved?.startOffset).toBe(0);
    expect(resolved?.endOffset).toBe(10);
  });
});
