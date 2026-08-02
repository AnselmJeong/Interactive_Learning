import { describe, expect, test } from "bun:test";
import type { MaterialAnnotation } from "../../shared/artifact-types";
import type { TutorMessage } from "../../shared/tutor-types";
import {
  additionalExplorationChoices,
  additionalExplorationContext,
  isAdditionalExplorationSaved,
  savedAdditionalExplorationTitles,
} from "./additional-exploration";

function message(): TutorMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "현재 설명",
    sourceRefs: ["chunk-1"],
    choices: [],
    createdAt: 1,
    ordinal: 1,
  };
}

function savedExploration(): MaterialAnnotation {
  return {
    id: "annotation-1",
    projectId: "project-1",
    materialId: "material-1",
    sourceId: "source-1",
    chunkId: "chunk-1",
    surface: "chat",
    scope: "session",
    sessionId: "session-1",
    anchorMessageId: "message-1",
    anchorBlockId: null,
    textAnchor: null,
    kind: "question",
    selectedText: "원문 대목",
    normalizedText: "원문 대목",
    result: {
      kind: "question_thread",
      version: 1,
      origin: "suggested_exploration",
      title: "새로운 관점은 무엇인가요?",
      messages: [],
      provider: "ai",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: 1,
      sourceMeta: [],
    },
    sourceMeta: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("additional exploration", () => {
  test("keeps novel questions while removing progression commands and duplicates", () => {
    expect(additionalExplorationChoices([
      "다음 대목으로 넘어가주세요.",
      "새로운 관점은 무엇인가요?",
      "  새로운   관점은 무엇인가요?  ",
      "반대 사례도 있을까요?",
      "네, 마칠게요.",
    ])).toEqual(["새로운 관점은 무엇인가요?", "반대 사례도 있을까요?"]);
  });

  test("recognizes a saved suggestion after annotations are reloaded", () => {
    const saved = savedAdditionalExplorationTitles([savedExploration()], "message-1");
    expect(isAdditionalExplorationSaved(saved, "새로운 관점은 무엇인가요?")).toBe(true);
    expect(isAdditionalExplorationSaved(saved, "다른 질문")).toBe(false);
  });

  test("grounds exploration in the source passage before the rendered summary", () => {
    expect(additionalExplorationContext(message(), {
      chunkId: "chunk-1",
      title: "자료",
      locator: "1장",
      text: "실제   원문 대목",
    })).toBe("실제 원문 대목");
  });
});
