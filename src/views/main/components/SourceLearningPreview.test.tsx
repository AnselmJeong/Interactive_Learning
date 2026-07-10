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
});
