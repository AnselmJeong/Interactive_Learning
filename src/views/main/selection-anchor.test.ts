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

  test("matches text when a rendered numbered-list marker is included in the selection", () => {
    const scopeText = "중세 스콜라 철학은 엄격한 추론 훈련을 제공했습니다.";
    const selectedText = "중세 스콜라 철학은";

    expect(findTextMatches(scopeText, "01 중세 스콜라 철학은")).toEqual([
      { startOffset: 0, endOffset: selectedText.length },
    ]);
    expect(findTextMatches(scopeText, "1. 중세 스콜라 철학은")).toEqual([
      { startOffset: 0, endOffset: selectedText.length },
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

  test("resolves anchors saved with a generated numbered-list marker", () => {
    const anchor: TextSelectionAnchor = {
      version: 1,
      surface: "chat",
      scope: "tutor-block",
      chunkId: "chunk-1",
      messageId: "message-1",
      blockId: "message-1:block-0",
      selectedText: "03 그러나 그 자리를 대체할 새로운 방법론은 등장하지 않았고",
      normalizedText: "03 그러나 그 자리를 대체할 새로운 방법론은 등장하지 않았고",
      occurrence: 0,
      startOffset: 999,
      endOffset: 1060,
      prefix: "",
      suffix: "",
      scopeTextLength: 86,
    };

    const scopeText =
      "중세 스콜라 철학은 엄격한 추론 훈련을 제공했습니다." +
      "르네상스 인문주의자들이 이 논리학도 함께 유행에서 벗어났습니다." +
      "그러나 그 자리를 대체할 새로운 방법론은 등장하지 않았고";

    const resolved = resolveTextSelectionAnchor({
      root: fakeRoot(scopeText),
      annotation: annotationWithAnchor(anchor),
    });

    expect(resolved?.text).toBe("그러나 그 자리를 대체할 새로운 방법론은 등장하지 않았고");
    expect(resolved?.startOffset).toBe(scopeText.indexOf("그러나"));
  });
});
