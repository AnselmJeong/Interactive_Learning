import { describe, expect, test } from "bun:test";
import type { MaterialAnnotation } from "../../shared/artifact-types";
import { inlineAnnotationTagName, inlineClasses, isInteractiveInlineAnnotation } from "./annotation-inline-links";

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
});
