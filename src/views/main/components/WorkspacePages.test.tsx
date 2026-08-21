import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MaterialAnnotation } from "../../../shared/artifact-types";
import type { ProjectSummary } from "../../../shared/rpc-types";
import { activityCalendar, annotationListPreview, LibraryPage, lookupKeyword, questionAnswer, questionPrompt } from "./WorkspacePages";

function annotation(kind: MaterialAnnotation["kind"], selectedText: string): MaterialAnnotation {
  return {
    id: `annotation-${kind}`,
    projectId: "project-1",
    materialId: "material-1",
    sourceId: "source-1",
    chunkId: "chunk-1",
    surface: "source",
    kind,
    selectedText,
    normalizedText: selectedText,
    result: kind === "highlight" ? { kind: "highlight", style: "marker-yellow" } : { kind: "note", note: "A separate note." },
    sourceMeta: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

test("project workspace names the concept consistently and exposes export", () => {
  const project: ProjectSummary = {
    id: "project-1",
    title: "Cognitive Neuroscience",
    description: null,
    rootPath: "/tmp/projects",
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: null,
    archivedAt: null,
    learningLevel: "medium",
  };
  const html = renderToStaticMarkup(createElement(LibraryPage, {
    project,
    documents: [],
    sources: [],
    selectedDocumentId: null,
    progress: null,
    busy: false,
    onImport: () => undefined,
    onExportProject: () => undefined,
    onOpenDocument: () => undefined,
    onFindMetadata: () => undefined,
    onDeleteDocument: () => undefined,
  }));

  expect(html).toContain("나의 프로젝트");
  expect(html).toContain("Current project");
  expect(html).toContain("프로젝트 내보내기");
  expect(html).not.toContain("나의 라이브러리");
});

test("highlight record list does not repeat its selected text as a preview", () => {
  expect(annotationListPreview(annotation("highlight", "이미 제목으로 표시되는 하이라이트"))).toBeNull();
});

test("non-highlight records keep their useful detail preview", () => {
  expect(annotationListPreview(annotation("note", "선택한 문장"))).toBe("A separate note.");
});

test("question records separate the user question, selected text, and assistant answer", () => {
  const question = {
    ...annotation("question", "선택한 문장"),
    result: {
      kind: "question_thread" as const,
      version: 1 as const,
      title: "대화 제목",
      messages: [
        { id: "user-1", role: "user" as const, content: "사용자가 실제로 물은 질문", createdAt: 1 },
        { id: "assistant-1", role: "assistant" as const, content: "AI의 답변", createdAt: 2 },
      ],
      provider: "ai" as const,
      retrievedAt: "2026-08-02T00:00:00Z",
      updatedAt: 2,
      sourceMeta: [],
    },
  } satisfies MaterialAnnotation;

  expect(questionPrompt(question)).toBe("사용자가 실제로 물은 질문");
  expect(annotationListPreview(question)).toBe("선택한 문장");
  expect(questionAnswer(question)).toBe("AI의 답변");
});

test("lookup records use the search keyword without repeating a generated title or body in the list", () => {
  const lookup = {
    ...annotation("lookup", "선택한 문장"),
    result: {
      kind: "lookup" as const,
      title: "불필요한 생성 제목",
      body: "설명",
      query: "haecceity",
      provider: "ai" as const,
      retrievedAt: "2026-08-02T00:00:00Z",
      sourceMeta: [],
    },
  } satisfies MaterialAnnotation;

  expect(lookupKeyword(lookup)).toBe("haecceity");
  expect(annotationListPreview(lookup)).toBeNull();
});

test("activity calendar uses weekly columns and makes busier days darker", () => {
  const calendar = activityCalendar([
    { date: "2026-07-27", viewedChunks: 1 },
    { date: "2026-08-02", viewedChunks: 4 },
  ], new Date(2026, 7, 2));

  expect(calendar.weeks).toHaveLength(52);
  expect(calendar.cells[51]?.[0]).toMatchObject({ date: "2026-07-27", count: 1, level: 1 });
  expect(calendar.cells[51]?.[6]).toMatchObject({ date: "2026-08-02", count: 4, level: 4 });
});
