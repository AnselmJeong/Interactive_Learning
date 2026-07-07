import { describe, expect, test } from "bun:test";
import type { MaterialAnnotation } from "../../shared/artifact-types";
import type { TutorContentBlock, TutorMessage } from "../../shared/tutor-types";
import { placeAnnotationsForMessages, shouldRenderSourceAnnotationCard } from "./annotation-placement";

function assistantMessage(id: string, sourceRefs: string[], blocks?: TutorContentBlock[]): TutorMessage {
  return {
    id,
    role: "assistant",
    content: "message",
    blocks,
    moduleId: "module-1",
    sourceRefs,
    choices: [],
    createdAt: 1,
    ordinal: 1,
  };
}

function annotation(id: string, chunkId: string, overrides: Partial<MaterialAnnotation> = {}): MaterialAnnotation {
  return {
    id,
    projectId: "project-1",
    materialId: "material-1",
    sourceId: "source-1",
    chunkId,
    surface: "chat",
    kind: "lookup",
    selectedText: "selected",
    normalizedText: "selected",
    result: {
      kind: "lookup",
      title: "selected",
      body: "summary",
      query: "selected",
      provider: "ai",
      model: "test",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      sourceMeta: [],
    },
    sourceMeta: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("annotation placement", () => {
  test("keeps anchored annotations off later messages that only share the source chunk", () => {
    const anchored = annotation("annotation-1", "chunk-1", { anchorMessageId: "previous-message" });
    const placement = placeAnnotationsForMessages([anchored], [assistantMessage("next-message", ["chunk-1"])]);

    expect(placement.groups.get("next-message") || []).toHaveLength(0);
    expect(placement.blockGroups.size).toBe(0);
    expect(placement.unplaced).toHaveLength(0);
  });

  test("places anchored annotations on the exact visible message", () => {
    const anchored = annotation("annotation-1", "chunk-1", { anchorMessageId: "message-1" });
    const placement = placeAnnotationsForMessages([anchored], [assistantMessage("message-1", ["chunk-1"])]);

    expect(placement.groups.get("message-1")?.map((item) => item.id)).toEqual(["annotation-1"]);
    expect(placement.unplaced).toHaveLength(0);
  });

  test("places block anchors on the exact rendered block", () => {
    const anchored = annotation("annotation-1", "chunk-1", { anchorMessageId: "message-1", anchorBlockId: "message-1:block-0" });
    const placement = placeAnnotationsForMessages([anchored], [
      assistantMessage("message-1", ["chunk-1"], [{ type: "paragraph", body: "block text" }]),
    ]);

    expect(placement.blockGroups.get("message-1:block-0")?.map((item) => item.id)).toEqual(["annotation-1"]);
    expect(placement.groups.size).toBe(0);
  });

  test("does not place unanchored annotations by source chunk alone", () => {
    const unanchored = annotation("annotation-1", "chunk-1");
    const placement = placeAnnotationsForMessages([unanchored], [assistantMessage("message-1", ["chunk-1"])]);

    expect(placement.groups.get("message-1") || []).toHaveLength(0);
    expect(placement.unplaced).toHaveLength(0);
  });

  test("does not place source-surface annotations in chat", () => {
    const sourceAnnotation = annotation("annotation-1", "chunk-1", { surface: "source" });
    const placement = placeAnnotationsForMessages([sourceAnnotation], [assistantMessage("message-1", ["chunk-1"])]);

    expect(placement.groups.get("message-1") || []).toHaveLength(0);
  });

  test("shows only source-surface lookup cards in the source document", () => {
    const sourceLookup = annotation("source-lookup", "chunk-1", { surface: "source" });
    const chatLookup = annotation("chat-lookup", "chunk-1", { surface: "chat", anchorMessageId: "message-1" });
    const highlight = annotation("highlight", "chunk-1", { surface: "source", kind: "highlight", result: { kind: "highlight" } });

    expect(shouldRenderSourceAnnotationCard(sourceLookup)).toBe(true);
    expect(shouldRenderSourceAnnotationCard(chatLookup)).toBe(false);
    expect(shouldRenderSourceAnnotationCard(highlight)).toBe(false);
  });

  test("keeps saved figure explanations with the figure instead of the generic source annotation list", () => {
    const figureExplanation = annotation("figure-explanation", "chunk-1", {
      surface: "source",
      sourceMeta: [{ title: "fig-0001", provider: "learnie.figure-explanation" }],
      result: {
        kind: "lookup",
        title: "그림 설명",
        body: "The image explanation",
        query: "Figure from source",
        provider: "ai",
        model: "test",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        sourceMeta: [{ title: "fig-0001", provider: "learnie.figure-explanation" }],
      },
    });

    expect(shouldRenderSourceAnnotationCard(figureExplanation)).toBe(false);
  });
});
