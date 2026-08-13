import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreparedLearningIr } from "../../../shared/learning-ir-types";
import { LearningGuideView } from "./LearningGuideView";

const ir: PreparedLearningIr = {
  schemaVersion: 1,
  materialId: "material-1",
  messageSetId: "set-1",
  messageSetFingerprint: "fingerprint",
  generatedAt: "2026-08-13T00:00:00.000Z",
  generator: { model: "test", compilerVersion: "prepared-learning-ir-v4", promptVersion: "prepared-learning-ir-extract-v4" },
  concepts: [
    { id: "neuron", label: "뉴런 (Neuron)", definition: "막전위 $V$로 신호를 전달하는 세포이다.", learningSignificance: "회로를 따라 전기 신호를 전달한다.", firstIntroducedMessageId: "m1", reinforcedMessageIds: ["m2"], sourceChunkIds: ["c1"] },
    { id: "synapse", label: "시냅스 (Synapse)", definition: "뉴런 사이의 접합부이다.", learningSignificance: "한 뉴런의 신호를 다음 반응으로 바꾼다.", firstIntroducedMessageId: "m2", reinforcedMessageIds: [], sourceChunkIds: ["c2"] },
    { id: "membrane", label: "막전위 (Membrane Potential)", definition: "세포막 양쪽의 전위차이다.", learningSignificance: "초기 수업에서 이미 다룬 개념이다.", firstIntroducedMessageId: "m1", reinforcedMessageIds: [], sourceChunkIds: ["c1"] },
    { id: "ion", label: "적응 지수 ($\\beta$)", definition: "막을 통과하는 전하의 흐름이다.", learningSignificance: "뒤에서 막전위를 설명할 때 사용한다.", firstIntroducedMessageId: "m3", reinforcedMessageIds: [], sourceChunkIds: ["c3"] },
  ],
  relations: [
    { id: "r1", fromConceptId: "neuron", toConceptId: "synapse", type: "enables", explanation: "뉴런의 막전위 $V$가 시냅스 전달을 거쳐 다음 세포에 도달한다.", messageIds: ["m2"], sourceChunkIds: ["c2"] },
  ],
  steps: [
    { messageId: "m1", routeIndex: 0, moduleId: "module-1", role: "introduce", summary: "Introduces the neuron as a signaling unit.", conceptIds: ["neuron"], relationIds: [], sourceChunkIds: ["c1"], visualId: null },
    { messageId: "m2", routeIndex: 1, moduleId: "module-1", role: "connect", summary: "Connects neuronal signaling to synaptic transmission.", conceptIds: ["neuron", "synapse"], relationIds: ["r1"], sourceChunkIds: ["c2"], visualId: null },
    { messageId: "m3", routeIndex: 2, moduleId: "module-1", role: "introduce", summary: "Introduces ionic current later in the route.", conceptIds: ["ion"], relationIds: [], sourceChunkIds: ["c3"], visualId: null },
  ],
  quality: { status: "good", issues: [], acceptedItemCount: 5, rejectedItemCount: 0 },
};

describe("completed Learning Guide", () => {
  test("places the selected concept explanation beside the graph and exposes its exact relation", () => {
    const html = renderToStaticMarkup(createElement(LearningGuideView, {
      result: { status: "ready", ir, error: null },
      onOpenSource: () => undefined,
      onOpenLearningMessage: () => undefined,
      learnedRouteIndex: 1,
      canOpenLearningMessage: (messageId) => messageId !== "m3",
    }));
    const workspaceStart = html.indexOf('class="concept-graph-workspace"');
    const detailStart = html.indexOf('class="concept-detail"');
    expect(workspaceStart).toBeGreaterThan(-1);
    expect(detailStart).toBeGreaterThan(workspaceStart);
    expect(html).toContain("수업에서 이 개념을 쓴 이유");
    expect(html).toContain("뉴런의 막전위");
    expect(html).toContain('class="katex"');
    expect(html.slice(workspaceStart, detailStart)).not.toContain('class="katex"');
    expect(html.slice(workspaceStart, detailStart)).toContain("적응 지수 (β)");
    expect(html).toContain("학습공간에서 처음 설명한 대목 보기");
    expect(html).not.toContain("학습함");
    expect(html).not.toContain("앞으로 배울 개념");
    expect(html).toContain('class="concept-node selected learned');
    expect(html).toContain('class="concept-node connected learned');
    expect(html).toContain('class="concept-node context-muted upcoming');
    expect(html).toContain('class="concept-node context-muted learned');
    expect(html).toContain("선택한 관계");
    expect(html).toContain('class="concept-relation learned selected');
    expect(html).toContain("label-visible");
    expect(html).toContain('data-clears-selection="true"');
    expect(html).not.toContain("Introduces the neuron as a signaling unit.");
    expect(html).toContain("이 설명의 원문 보기");
    expect(html).not.toContain("원문 진입점");
  });

  test("opens a real guide page while the completed message set is still being compiled", () => {
    const html = renderToStaticMarkup(createElement(LearningGuideView, {
      result: { status: "generating", ir: null, error: null },
      busy: true,
    }));
    expect(html).toContain("학습지도를 만들고 있습니다");
    expect(html).toContain("사전 생성 메시지는 모두 준비되었습니다");
  });

  test("shows the generation error and a retry action instead of a dead tab", () => {
    const html = renderToStaticMarkup(createElement(LearningGuideView, {
      result: { status: "unavailable", ir: null, error: "provider 응답이 없습니다." },
      onRetry: () => undefined,
    }));
    expect(html).toContain("학습지도를 표시하지 못했습니다");
    expect(html).toContain("provider 응답이 없습니다.");
    expect(html).toContain("다시 만들기");
  });
});
