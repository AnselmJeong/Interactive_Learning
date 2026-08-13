import { describe, expect, test } from "bun:test";
import type { AiChatClient } from "./openai-compatible-client";
import { compilePreparedLearningIr, type PreparedLearningMessageInput } from "./prepared-learning-ir-compiler";

const messages: PreparedLearningMessageInput[] = [
  {
    id: "set-1:0",
    routeIndex: 0,
    moduleId: "module-1",
    targetEvent: "start_module",
    content: "A neuron sends an action potential. The synapse converts that electrical event into chemical transmission.",
    blocks: [],
    sourceChunkIds: ["chunk-1"],
    visualId: null,
  },
  {
    id: "set-1:1",
    routeIndex: 1,
    moduleId: "module-1",
    targetEvent: "next_chunk",
    content: "Neurotransmitter release enables a postsynaptic response, connecting one neuron to the next.",
    blocks: [],
    sourceChunkIds: ["chunk-2"],
    visualId: "figure-1",
  },
];

function client(responses: unknown[]): AiChatClient {
  let index = 0;
  return {
    listModels: async () => [],
    chatText: async () => "",
    chatJson: async () => responses[index++],
  };
}

describe("prepared Learning IR compiler", () => {
  test("builds the learner-facing graph from completed messages and rejects headings or figures as concepts", async () => {
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-1",
      messages,
      runtime: {
        model: "test-model",
        client: client([
          {
            concepts: [
              { key: "c1", label: "뉴런 (Neuron)", definition: "신호를 전달하는 신경 세포이다.", learningSignificance: "신호 전달 과정에서 보내고 받는 단위이다.", messageIds: ["set-1:0", "set-1:1"], sourceChunkIds: ["chunk-1", "chunk-2"] },
              { key: "c2", label: "시냅스 (Synapse)", definition: "뉴런 사이에서 신호를 전달하는 접합부이다.", learningSignificance: "시냅스 전 사건을 시냅스 후 반응으로 바꾼다.", messageIds: ["set-1:0", "set-1:1"], sourceChunkIds: ["chunk-1", "chunk-2"] },
              { key: "c3", label: "Figure 2.1", definition: "A figure.", learningSignificance: "It is a picture.", messageIds: ["set-1:1"], sourceChunkIds: ["chunk-2"] },
            ],
            relations: [{ fromKey: "c1", toKey: "c2", type: "enables", explanation: "뉴런의 신호는 시냅스를 통해 다음 세포로 전달된다.", messageIds: ["set-1:1"], sourceChunkIds: ["chunk-2"] }],
            steps: [
              { messageId: "set-1:0", role: "introduce", summary: "Introduces neuronal signaling and the synapse.", conceptKeys: ["c1", "c2"] },
              { messageId: "set-1:1", role: "connect", summary: "Connects transmitter release to the postsynaptic response.", conceptKeys: ["c1", "c2"] },
            ],
          },
          {
            concepts: [
              { label: "뉴런 (Neuron)", definition: "신호를 전달하는 신경 세포이다.", learningSignificance: "신호 전달 과정에서 보내고 받는 단위이다.", messageIds: ["set-1:0", "set-1:1"], sourceChunkIds: ["chunk-1", "chunk-2"] },
              { label: "시냅스 (Synapse)", definition: "뉴런 사이에서 신호를 전달하는 접합부이다.", learningSignificance: "시냅스 전 사건을 시냅스 후 반응으로 바꾼다.", messageIds: ["set-1:0", "set-1:1"], sourceChunkIds: ["chunk-1", "chunk-2"] },
            ],
            relations: [{ fromLabel: "뉴런 (Neuron)", toLabel: "시냅스 (Synapse)", type: "enables", explanation: "뉴런의 신호가 시냅스 전달을 거쳐 다른 뉴런에 도달한다.", messageIds: ["set-1:1"], sourceChunkIds: ["chunk-2"] }],
          },
        ]),
      },
      generatedAt: "2026-08-13T00:00:00.000Z",
    });

    expect(ir.concepts.map((concept) => concept.label)).toEqual(["뉴런 (Neuron)", "시냅스 (Synapse)"]);
    expect(ir.concepts.some((concept) => concept.label.startsWith("Figure"))).toBe(false);
    expect(ir.relations).toHaveLength(1);
    expect(ir.steps[0]?.conceptIds).toHaveLength(2);
    expect(ir.quality.status).toBe("good");
  });

  test("returns a degraded IR instead of manufacturing a fallback graph", async () => {
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-2",
      messages,
      runtime: { model: "test-model", client: client([{ concepts: [], relations: [], steps: [] }, { concepts: [], relations: [] }]) },
    });
    expect(ir.concepts).toEqual([]);
    expect(ir.relations).toEqual([]);
    expect(ir.quality.status).toBe("degraded");
  });

  test("preserves concepts from the full prepared route when global reduction favors only the opening", async () => {
    const fullRouteMessages = Array.from({ length: 8 }, (_, index): PreparedLearningMessageInput => ({
      id: `full-route:${index}`,
      routeIndex: index,
      moduleId: `module-${Math.floor(index / 2) + 1}`,
      targetEvent: index ? "next_chunk" : "start_module",
      content: `${index + 1}번째 학습 구간에서 서로 다른 핵심 개념을 설명한다.`,
      blocks: [],
      sourceChunkIds: [`full-chunk-${index}`],
      visualId: null,
    }));
    const extractedConcepts = fullRouteMessages.map((message, index) => ({
      key: `c${index}`,
      label: `전체 개념 ${index + 1}`,
      definition: `${index + 1}번째 구간에서 설명하는 고유한 개념이다.`,
      learningSignificance: `${index + 1}번째 학습 구간을 이해하는 데 필요하다.`,
      messageIds: [message.id],
      sourceChunkIds: message.sourceChunkIds,
    }));
    const extractedRelations = extractedConcepts.slice(0, -1).map((concept, index) => ({
      fromKey: concept.key,
      toKey: extractedConcepts[index + 1]!.key,
      type: "prerequisite_for",
      explanation: `전체 개념 ${index + 1}은 전체 개념 ${index + 2}의 이해를 준비한다.`,
      messageIds: [fullRouteMessages[index + 1]!.id],
      sourceChunkIds: fullRouteMessages[index + 1]!.sourceChunkIds,
    }));
    const ir = await compilePreparedLearningIr({
      materialId: "material-full-route",
      messageSetId: "set-full-route",
      messages: fullRouteMessages,
      runtime: {
        model: "test-model",
        client: client([
          { concepts: extractedConcepts, relations: extractedRelations },
          {
            concepts: extractedConcepts.slice(0, 2).map(({ key: _key, ...concept }) => concept),
            relations: [{
              fromLabel: "전체 개념 1",
              toLabel: "전체 개념 2",
              type: "prerequisite_for",
              explanation: "전체 개념 1은 전체 개념 2의 이해를 준비한다.",
              messageIds: ["full-route:1"],
              sourceChunkIds: ["full-chunk-1"],
            }],
          },
        ]),
      },
    });
    expect(ir.concepts).toHaveLength(8);
    expect(ir.relations).toHaveLength(7);
    expect(new Set(ir.concepts.map((concept) => concept.firstIntroducedMessageId))).toContain("full-route:7");
  });

  test("rejects English-only learner-facing concepts instead of mixing languages", async () => {
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-korean-only",
      messages,
      runtime: {
        model: "test-model",
        client: client([
          {
            concepts: [
              { key: "c1", label: "Neuron", definition: "A cell that transmits a signal.", learningSignificance: "It carries an electrical event.", messageIds: ["set-1:0"], sourceChunkIds: ["chunk-1"] },
              { key: "c2", label: "Synapse", definition: "A junction between neurons.", learningSignificance: "It passes the event to another cell.", messageIds: ["set-1:1"], sourceChunkIds: ["chunk-2"] },
            ],
            relations: [{ fromKey: "c1", toKey: "c2", type: "enables", explanation: "The neuron sends its signal through the synapse.", messageIds: ["set-1:1"], sourceChunkIds: ["chunk-2"] }],
          },
          { concepts: [], relations: [] },
        ]),
      },
    });
    expect(ir.concepts).toEqual([]);
    expect(ir.relations).toEqual([]);
    expect(ir.quality.status).toBe("degraded");
  });

  test("extracts independent message batches concurrently while preserving their order", async () => {
    const longMessages = Array.from({ length: 24 }, (_, index): PreparedLearningMessageInput => ({
      id: `set-3:${index}`,
      routeIndex: index,
      moduleId: "module-1",
      targetEvent: index === 23 ? "finish_prompt" : "next_chunk",
      content: `${index} ${"message content ".repeat(140)}`,
      blocks: [],
      sourceChunkIds: [`chunk-${index}`],
      visualId: null,
    }));
    let activeExtractions = 0;
    let maximumActiveExtractions = 0;
    const runtimeClient: AiChatClient = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async (request) => {
        const payload = JSON.parse(String(request.messages[1]?.content || "[]")) as unknown;
        if (Array.isArray(payload)) {
          activeExtractions += 1;
          maximumActiveExtractions = Math.max(maximumActiveExtractions, activeExtractions);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeExtractions -= 1;
          return { concepts: [], relations: [], steps: [] };
        }
        return { concepts: [], relations: [] };
      },
    };
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-3",
      messages: longMessages,
      runtime: { model: "test-model", client: runtimeClient },
    });
    expect(maximumActiveExtractions).toBeGreaterThan(1);
    expect(maximumActiveExtractions).toBeLessThanOrEqual(3);
    expect(ir.steps.map((step) => step.messageId)).toEqual(longMessages.map((message) => message.id));
  });

  test("splits an extraction batch when the provider reaches its output token limit", async () => {
    const splitMessages = Array.from({ length: 4 }, (_, index): PreparedLearningMessageInput => ({
      ...messages[index % messages.length]!,
      id: `set-4:${index}`,
      routeIndex: index,
      sourceChunkIds: [`chunk-${index}`],
    }));
    const extractionSizes: number[] = [];
    const runtimeClient: AiChatClient = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async (request) => {
        const payload = JSON.parse(String(request.messages[1]?.content || "[]")) as unknown;
        if (!Array.isArray(payload)) return { concepts: [], relations: [] };
        extractionSizes.push(payload.length);
        if (payload.length > 2) throw new Error("finish_reason=length: output token limit");
        return { concepts: [], relations: [] };
      },
    };
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-4",
      messages: splitMessages,
      runtime: { model: "test-model", client: runtimeClient },
    });
    expect(extractionSizes).toEqual([4, 2, 2]);
    expect(ir.steps).toHaveLength(4);
  });

  test("derives source chunks from cited messages and keeps grounded extraction when reduction is empty", async () => {
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-5",
      messages,
      runtime: {
        model: "test-model",
        client: client([
          {
            concepts: [
              { key: "c1", label: "뉴런 (Neuron)", definition: "신호를 전달하는 세포이다.", learningSignificance: "전기적 사건을 전달한다.", messageIds: ["set-1:0"] },
              { key: "c2", label: "시냅스 (Synapse)", definition: "뉴런 사이의 접합부이다.", learningSignificance: "사건을 다음 세포로 전달한다.", messageIds: ["set-1:0", "set-1:1"] },
            ],
            relations: [
              { fromKey: "c1", toKey: "c2", type: "enables", explanation: "뉴런의 사건은 시냅스를 통해 다음 세포에 도달한다.", messageIds: ["set-1:0"] },
            ],
          },
          { concepts: [], relations: [] },
        ]),
      },
    });
    expect(ir.concepts.map((concept) => concept.sourceChunkIds)).toEqual([["chunk-1"], ["chunk-1", "chunk-2"]]);
    expect(ir.relations[0]?.sourceChunkIds).toEqual(["chunk-1"]);
    expect(ir.quality.status).toBe("good");
  });

  test("normalizes wrapped snake-case provider JSON without weakening evidence checks", async () => {
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-6",
      messages,
      runtime: {
        model: "test-model",
        client: client([
          {
            result: {
              graph: {
                concept_nodes: [
                  { concept_key: "c1", name: "뉴런 (Neuron)", description: "신호를 전달하는 세포이다.", learning_significance: "전기적 사건을 전달한다.", message_ids: ["set-1:0"] },
                  { concept_key: "c2", name: "시냅스 (Synapse)", description: "뉴런 사이의 접합부이다.", learning_significance: "사건을 다음 세포로 전달한다.", message_ids: ["set-1:0", "set-1:1"] },
                ],
                concept_relations: [
                  { from_key: "c1", to_key: "c2", relation_type: "enables", description: "뉴런의 사건은 시냅스를 통해 다음 세포에 도달한다.", message_ids: ["set-1:0"] },
                ],
              },
            },
          },
          { concepts: [], relations: [] },
        ]),
      },
    });
    expect(ir.concepts.map((concept) => concept.label)).toEqual(["뉴런 (Neuron)", "시냅스 (Synapse)"]);
    expect(ir.relations).toHaveLength(1);
    expect(ir.quality.status).toBe("good");
  });

  test("keeps grounded batch relations when only the global reduction hits its output limit", async () => {
    let call = 0;
    const runtimeClient: AiChatClient = {
      listModels: async () => [],
      chatText: async () => "",
      chatJson: async () => {
        call += 1;
        if (call > 1) throw new Error("finish_reason=length: output token limit");
        return {
          concepts: [
            { key: "c1", label: "뉴런 (Neuron)", definition: "신호를 전달하는 세포이다.", learningSignificance: "전기적 사건을 전달한다.", messageIds: ["set-1:0"] },
            { key: "c2", label: "시냅스 (Synapse)", definition: "뉴런 사이의 접합부이다.", learningSignificance: "사건을 다음 세포로 전달한다.", messageIds: ["set-1:0"] },
          ],
          relations: [
            { fromKey: "c1", toKey: "c2", type: "enables", explanation: "뉴런의 사건은 시냅스를 통해 다음 세포에 도달한다.", messageIds: ["set-1:0"] },
          ],
        };
      },
    };
    const ir = await compilePreparedLearningIr({
      materialId: "material-1",
      messageSetId: "set-7",
      messages,
      runtime: {
        model: "test-model",
        client: runtimeClient,
      },
    });
    expect(ir.concepts.map((concept) => concept.label)).toEqual(["뉴런 (Neuron)", "시냅스 (Synapse)"]);
    expect(ir.relations).toHaveLength(1);
    expect(ir.quality.status).toBe("good");
  });
});
