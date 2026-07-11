import { describe, expect, test } from "bun:test";
import type { MaterialAnnotation } from "../../shared/artifact-types";
import {
  inlineAnnotationTagName,
  inlineClasses,
  isInteractiveInlineAnnotation,
  resolveTextNodeRangeOffsets,
} from "./annotation-inline-links";

function annotation(kind: MaterialAnnotation["kind"]): MaterialAnnotation {
  return {
    id: `${kind}-annotation`,
    projectId: "project-1",
    materialId: "material-1",
    sourceId: "source-1",
    chunkId: "chunk-1",
    surface: kind === "highlight" ? "source" : "chat",
    kind,
    selectedText: "selected text",
    normalizedText: "selected text",
    result: kind === "highlight"
      ? { kind: "highlight", style: "yellow" }
      : kind === "note"
        ? { kind: "note", note: "my note" }
        : {
          kind: "lookup",
          title: "selected text",
          body: "summary",
          query: "selected text",
          provider: "ai",
          model: "test",
          retrievedAt: "2026-01-01T00:00:00.000Z",
          sourceMeta: [],
        },
    sourceMeta: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("annotation inline links", () => {
  test("renders lookup annotations as interactive links", () => {
    const lookup = annotation("lookup");

    expect(isInteractiveInlineAnnotation(lookup)).toBe(true);
    expect(inlineAnnotationTagName(lookup)).toBe("a");
    expect(inlineClasses(lookup, null)).toContain("annotation-inline-link");
  });

  test("renders highlights as non-interactive marks", () => {
    const highlight = annotation("highlight");

    expect(isInteractiveInlineAnnotation(highlight)).toBe(false);
    expect(inlineAnnotationTagName(highlight)).toBe("mark");
    expect(inlineClasses(highlight, null)).toContain("annotation-inline-mark");
    expect(inlineClasses(highlight, null)).not.toContain("annotation-inline-link");
  });

  test("renders notes as interactive links to their annotation card", () => {
    const note = annotation("note");

    expect(isInteractiveInlineAnnotation(note)).toBe(true);
    expect(inlineAnnotationTagName(note)).toBe("a");
    expect(inlineClasses(note, null)).toContain("annotation-inline-link");
    expect(inlineClasses(note, null)).toContain("annotation-kind-note");
  });

  test("starts annotation ranges in the following text node at paragraph boundaries", () => {
    const labelLength = "함께 읽기".length;
    const paragraphLength = "산술의 토큰은 숫자입니다.".length;

    expect(resolveTextNodeRangeOffsets([labelLength, paragraphLength], labelLength, labelLength + "산술의".length)).toEqual({
      start: { nodeIndex: 1, nodeOffset: 0 },
      end: { nodeIndex: 1, nodeOffset: "산술의".length },
    });
  });

  test("keeps range ends on the previous text node at paragraph boundaries", () => {
    const firstParagraphLength = "첫 문장입니다.".length;
    const secondParagraphLength = "둘째 문장입니다.".length;

    expect(resolveTextNodeRangeOffsets([firstParagraphLength, secondParagraphLength], 0, firstParagraphLength)).toEqual({
      start: { nodeIndex: 0, nodeOffset: 0 },
      end: { nodeIndex: 0, nodeOffset: firstParagraphLength },
    });
  });
});
