import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MaterialArtifacts } from "../../../shared/artifact-types";
import { SourceLearningPreview } from "./SourceLearningPreview";

describe("SourceLearningPreview", () => {
  test("shows the subject overview and module titles without repeated goals or actions", () => {
    const artifacts = {
      overview: {
        paragraph: "이 글은 문제 해결 과정에서 표현 방식과 선택 가능한 행동이 어떻게 서로를 규정하는지 분석한다.",
        sourceChunkIds: ["chunk-1"],
        generatedAt: "2026-07-10T00:00:00.000Z",
        generatorVersion: "material-overview-v2-llm-full-source",
      },
      coursePlan: {
        id: "course-1",
        title: "문제 해결",
        subtitle: "",
        audience: "",
        estimatedTimeMinutes: 10,
        modules: [
          {
            id: "module-1",
            title: "1. 문제와 선택",
            learningGoal: "원문을 직접 읽지 않아도 핵심 주장과 긴장을 설명할 수 있다.",
            conceptIds: [],
            sourceChunkIds: ["chunk-1"],
            visualIds: [],
            hookIntent: "",
            checkpointRubric: "",
            masterySignals: [],
            misconceptionSignals: [],
            remediationStrategy: "",
          },
        ],
      },
      sourceChunks: [{ id: "chunk-1" }],
    } as unknown as MaterialArtifacts;

    const html = renderToStaticMarkup(createElement(SourceLearningPreview, { artifacts }));

    expect(html).toContain(artifacts.overview.paragraph);
    expect(html).toContain(">문제와 선택</strong>");
    expect(html).not.toContain(">1. 문제와 선택</strong>");
    expect(html).not.toContain("원문을 직접 읽지 않아도");
    expect(html).not.toContain("source-preview-actions");
    expect(html).not.toContain("<button");
  });

  test("uses the current source title instead of the generated artifact title", () => {
    const artifacts = {
      overview: { paragraph: "Overview" },
      coursePlan: { title: "STALE TITLE", estimatedTimeMinutes: 10, modules: [] },
      sourceChunks: [],
    } as unknown as MaterialArtifacts;

    const html = renderToStaticMarkup(createElement(SourceLearningPreview, { artifacts, title: "Renamed source" }));

    expect(html).toContain(">Renamed source</h2>");
    expect(html).not.toContain(">STALE TITLE</h2>");
  });

  test("shows only the topic overview for an article and hides module details", () => {
    const artifacts = {
      overview: { paragraph: "이 논문은 소셜 미디어 보상과 우울 관련 행동의 관계를 연구한다." },
      coursePlan: {
        title: "Article",
        estimatedTimeMinutes: 15,
        modules: [{ id: "module-1", title: "Results" }],
      },
      sourceChunks: [{ id: "chunk-1" }],
    } as unknown as MaterialArtifacts;

    const html = renderToStaticMarkup(createElement(SourceLearningPreview, { artifacts, documentType: "article" }));

    expect(html).toContain("이 논문이 다루는 것");
    expect(html).toContain(artifacts.overview.paragraph);
    expect(html).toContain(" Article</span>");
    expect(html).not.toContain("학습 흐름");
    expect(html).not.toContain("modules");
    expect(html).not.toContain(">Results</strong>");
  });

  test("does not expose source-derived concepts as a learning guide before messages are complete", () => {
    const artifacts = {
      manifest: { id: "m1" },
      overview: { paragraph: "Legacy" },
      coursePlan: { title: "Source", estimatedTimeMinutes: 10, modules: [] },
      sourceChunks: [{ id: "chunk-1" }],
      visuals: [],
      learningIr: {
        concepts: [{ id: "concept-1", label: "Recognition", definition: "A social response.", whyItMatters: "It shapes action.", sourceChunkIds: ["chunk-1"] }],
      },
      sourceBrief: {
        schemaVersion: 1,
        materialId: "m1",
        scope: "single_source",
        documentType: "book",
        guidingQuestion: "How does recognition shape action?",
        summary: "The source connects recognition with action.",
        centralIdea: null,
        conceptIds: ["concept-1"],
        structureVisualId: null,
        misconceptions: [],
        anchors: [{ sourceChunkId: "chunk-1", label: "Opening", excerpt: "Recognition changes the available action." }],
        reviewPrompt: { prompt: "Connect recognition and action.", kind: "connect" },
        sourceFingerprint: "source",
        generatedAt: "2026-08-13T00:00:00.000Z",
        generatorVersion: "source-brief-v1",
        quality: { status: "good", issues: [], acceptedItemCount: 3, rejectedItemCount: 0 },
      },
    } as unknown as MaterialArtifacts;
    const html = renderToStaticMarkup(createElement(SourceLearningPreview, { artifacts }));
    expect(html).toContain("Legacy");
    expect(html).not.toContain("How does recognition shape action?");
    expect(html).not.toContain("원문 진입점");
    expect(html).not.toContain("학습공간에서 생각하기");
  });
});
