import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import { QuestionThreadAnnotationCard } from "./QuestionThreadAnnotationCard";

function questionAnnotation(): MaterialAnnotation {
  return {
      id: "annotation-1",
      projectId: "project-1",
      materialId: "material-1",
      sourceId: "source-1",
      chunkId: "chunk-1",
      surface: "chat",
      kind: "question",
      selectedText: "순수 기호주의와 체화된 인지 논쟁",
      normalizedText: "순수 기호주의와 체화된 인지 논쟁",
      result: {
        kind: "question_thread",
        version: 1,
        title: "이 두 접근법을 서로 비교해줘",
        messages: [
          { id: "user-1", role: "user", content: "이 두 접근법을 서로 비교해줘", createdAt: 1 },
          {
            id: "assistant-1",
            role: "assistant",
            content: "두 접근법의 핵심 차이는 다음과 같습니다. [S1]",
            createdAt: 2,
            sources: [{ id: "S1", title: "Embodied cognition", url: "https://example.com/paper", snippet: "Research excerpt" }],
          },
        ],
        provider: "ai",
        retrievedAt: "2026-07-10T00:00:00.000Z",
        updatedAt: 2,
        sourceMeta: [],
      },
      sourceMeta: [],
      createdAt: 1,
      updatedAt: 2,
  };
}

describe("QuestionThreadAnnotationCard", () => {
  test("keeps the accordion header limited to the selected text", () => {
    const annotation = questionAnnotation();

    const html = renderToStaticMarkup(createElement(QuestionThreadAnnotationCard, {
      annotation,
      active: false,
      expanded: true,
      onToggle: () => undefined,
      onContinue: () => undefined,
      onLocate: () => true,
      onDelete: () => undefined,
    }));
    const header = html.match(/<header>(.*?)<\/header>/)?.[1] || "";

    expect(header).toContain(annotation.selectedText);
    expect(header).not.toContain("이 두 접근법을 서로 비교해줘");
    expect(header).not.toContain("개 질문");
    expect(html.split("이 두 접근법을 서로 비교해줘")).toHaveLength(2);
    expect(header).toContain('aria-label="원문 위치"');
    expect(header).toContain('aria-label="삭제"');
    expect(html).toContain("example.com");
    expect(html).toContain("S1");
  });

  test("labels AI suggestion annotations as additional exploration", () => {
    const annotation = questionAnnotation();
    if (annotation.result.kind !== "question_thread") throw new Error("Expected question thread");
    annotation.result.origin = "suggested_exploration";
    annotation.result.title = "새로운 관점은 무엇인가요?";

    const html = renderToStaticMarkup(createElement(QuestionThreadAnnotationCard, {
      annotation,
      active: false,
      expanded: false,
      onToggle: () => {},
      onContinue: () => {},
      onLocate: () => false,
      onDelete: () => {},
    }));

    expect(html).toContain("추가 탐색");
    expect(html).toContain("새로운 관점은 무엇인가요?");
    expect(html).not.toContain('aria-label="원문 위치"');
  });
});
