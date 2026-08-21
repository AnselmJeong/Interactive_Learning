import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentSummary } from "../../../shared/rpc-types";
import { BookMetadataModal } from "./BookMetadataModal";

function document(documentType: DocumentSummary["documentType"]): DocumentSummary {
  return {
    id: "document-1",
    projectId: "project-1",
    documentType,
    title: documentType === "article" ? "filename derived paper title" : "book filename",
    subtitle: null,
    description: null,
    authors: [],
    publisher: null,
    publishedDate: null,
    isbn10: null,
    isbn13: null,
    journal: null,
    doi: null,
    language: null,
    coverUrl: null,
    metadataStatus: "not_found",
    sourceCount: 1,
    learning: { status: "not_started", coveredChunks: 0, totalChunks: 0, percent: 0, currentSourceId: null, activeSessionId: null },
    preparation: { completedMessages: 0, totalMessages: 0, percent: 0 },
    annotationCount: 0,
    lastStudiedAt: null,
    originalFileName: "source.pdf",
    createdAt: 0,
    updatedAt: 0,
  };
}

const callbacks = {
  busy: false,
  onClose: () => undefined,
  onSearch: async () => [],
  onApply: async () => undefined,
  onApplyManual: async () => undefined,
};

describe("document metadata workflow", () => {
  test("uses ISBN-only Google Books search for books and keeps manual title entry", () => {
    const html = renderToStaticMarkup(createElement(BookMetadataModal, { ...callbacks, document: document("book") }));
    expect(html).toContain("Google Books 검색에는 ISBN이 필요합니다");
    expect(html).toContain("ISBN-10 또는 ISBN-13");
    expect(html).toContain("입력한 제목 사용");
    expect(html).not.toContain("Crossref 검색");
  });

  test("prefills an article filename title for Crossref and manual fallback", () => {
    const html = renderToStaticMarkup(createElement(BookMetadataModal, { ...callbacks, document: document("article") }));
    expect(html).toContain("filename derived paper title");
    expect(html).toContain("Crossref 검색");
    expect(html).toContain("입력한 제목 사용");
    expect(html).not.toContain("ISBN-10 또는 ISBN-13");
  });
});
