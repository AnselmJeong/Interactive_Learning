import { describe, expect, test } from "bun:test";
import type { PreparedLearningConcept, PreparedLearningRelation } from "../../shared/learning-ir-types";
import { layoutConceptGraph, routeConceptRelation } from "./concept-graph-layout";
import { compactConceptNodeLabel, isConceptGraphZoomEvent, plainConceptNodeLabel } from "./components/ConceptGraphView";

describe("dynamic concept graph input", () => {
  test("uses middle drag for pan while reserving left drag for nodes", () => {
    expect(isConceptGraphZoomEvent({ type: "pointerdown", button: 0 })).toBe(false);
    expect(isConceptGraphZoomEvent({ type: "pointerdown", button: 1 })).toBe(true);
    expect(isConceptGraphZoomEvent({ type: "wheel" })).toBe(true);
  });

  test("drops only a long English gloss from a compact node label", () => {
    expect(compactConceptNodeLabel("뉴런 (Neuron)")).toBe("뉴런 (Neuron)");
    expect(compactConceptNodeLabel("체세포-수상돌기 핑퐁 상호작용 (Soma-dendrite ping-pong interaction)"))
      .toBe("체세포-수상돌기 핑퐁 상호작용");
    expect(compactConceptNodeLabel("적응 지수 ($\\beta$)"))
      .toBe("적응 지수 ($\\beta$)");
  });

  test("renders node formulas as stable plain text instead of detached KaTeX layers", () => {
    expect(plainConceptNodeLabel("적응 지수 ($\\beta$)")).toBe("적응 지수 (β)");
    expect(plainConceptNodeLabel("유효 적응 시정수 ($\\tau_{\\mathrm{adap}}$)"))
      .toBe("유효 적응 시정수 (τ_adap)");
    expect(plainConceptNodeLabel("저역치 칼륨 전류 $I_{KS}$")).toBe("저역치 칼륨 전류 I_KS");
  });
});

const concepts: PreparedLearningConcept[] = [
  { id: "a", label: "A", definition: "A", learningSignificance: "A enables B.", firstIntroducedMessageId: "m1", reinforcedMessageIds: [], sourceChunkIds: ["c1"] },
  { id: "b", label: "B", definition: "B", learningSignificance: "B explains C.", firstIntroducedMessageId: "m2", reinforcedMessageIds: [], sourceChunkIds: ["c2"] },
  { id: "c", label: "C", definition: "C", learningSignificance: "C is the outcome.", firstIntroducedMessageId: "m3", reinforcedMessageIds: [], sourceChunkIds: ["c3"] },
];
const relations: PreparedLearningRelation[] = [
  { id: "r1", fromConceptId: "a", toConceptId: "b", type: "prerequisite_for", explanation: "A is needed for B.", messageIds: ["m2"], sourceChunkIds: ["c2"] },
  { id: "r2", fromConceptId: "b", toConceptId: "c", type: "explains", explanation: "B explains C.", messageIds: ["m3"], sourceChunkIds: ["c3"] },
];

describe("completed concept graph layout", () => {
  test("is deterministic and uses the completed message order to break graph cycles", () => {
    const order = new Map([["m1", 0], ["m2", 1], ["m3", 2]]);
    const first = layoutConceptGraph(concepts, relations, order);
    const second = layoutConceptGraph(concepts, relations, order);
    expect(first).toEqual(second);
    expect(first.nodes.find((node) => node.id === "a")!.layer).toBeLessThan(first.nodes.find((node) => node.id === "b")!.layer);
    expect(first.nodes.find((node) => node.id === "b")!.layer).toBeLessThan(first.nodes.find((node) => node.id === "c")!.layer);
  });

  test("routes a horizontal relation from one box boundary to the other", () => {
    const route = routeConceptRelation(
      { x: 0, y: 0, width: 160, height: 80 },
      { x: 300, y: 0, width: 160, height: 80 },
    );
    expect(route.start).toEqual({ x: 160, y: 40 });
    expect(route.end).toEqual({ x: 300, y: 40 });
    expect(route.label).toEqual({ x: 230, y: 40 });
  });

  test("routes a diagonal relation through the nearest edges instead of node centers", () => {
    const route = routeConceptRelation(
      { x: 20, y: 30, width: 160, height: 80 },
      { x: 300, y: 210, width: 160, height: 120 },
    );
    expect(route.start.y).toBe(110);
    expect(route.start.x).toBeGreaterThan(100);
    expect(route.end.x).toBe(300);
    expect(route.end.y).toBeGreaterThan(210);
  });

  test("keeps every concept and relation in the navigable canvas", () => {
    const manyConcepts = Array.from({ length: 24 }, (_, index): PreparedLearningConcept => ({
      id: `concept-${index}`,
      label: `개념 ${index}`,
      definition: `정의 ${index}`,
      learningSignificance: `학습 이유 ${index}`,
      firstIntroducedMessageId: `message-${index}`,
      reinforcedMessageIds: [],
      sourceChunkIds: [`chunk-${index}`],
    }));
    const manyRelations = manyConcepts.slice(0, -1).map((concept, index): PreparedLearningRelation => ({
      id: `relation-${index}`,
      fromConceptId: concept.id,
      toConceptId: manyConcepts[index + 1]!.id,
      type: "precedes",
      explanation: "다음 개념보다 먼저 학습한다.",
      messageIds: [`message-${index + 1}`],
      sourceChunkIds: [`chunk-${index + 1}`],
    }));
    const order = new Map(manyConcepts.map((concept, index) => [concept.firstIntroducedMessageId, index]));
    const layout = layoutConceptGraph(manyConcepts, manyRelations, order);
    expect(layout.nodes).toHaveLength(24);
    expect(layout.relations).toHaveLength(23);
    expect(layout.truncated).toBe(false);
  });
});
