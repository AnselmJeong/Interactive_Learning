import { describe, expect, test } from "bun:test";
import type { MaterialArtifacts, SourceChunk } from "../shared/artifact-types";
import type { SessionSnapshot, TutorContentBlock, TutorMessage, TutorTurnOutput } from "../shared/tutor-types";
import { compileDeepReading, currentDeepReading, normalizePassagePlan, passagePlanFor, readingContextChunks, validateExplanationGrounding, validatePassageEvidence } from "./deep-reading-service";
import { compileLearningIr } from "./learning-ir-compiler";
import { recallConversation } from "./conversation-recall";
import { buildGroundedVisuals } from "./visual-grammar";
import { estimateInitialMessageSetSize, TutorService } from "./tutor-service";

const chunks: SourceChunk[] = [
  { id: "a", headingPath: ["Autonomy"], locator: "p. 1", kind: "body", text: "Coerced action is not autonomous. Institutional control can constrain autonomous action.", confidence: 1 },
  { id: "b", headingPath: ["Definition"], locator: "p. 20", kind: "body", text: "Autonomy means acting on reasons one endorses. Institutional control does not always amount to coercion.", confidence: 1 },
  { id: "c", headingPath: ["Mechanism"], locator: "p. 30", kind: "body", text: "A current charges the membrane. A spike occurs only if the voltage reaches the threshold.", confidence: 1 },
];
const module = { id: "m", title: "Autonomy", learningGoal: "Distinguish coercion and control", conceptIds: [], sourceChunkIds: ["a"], visualIds: [], hookIntent: "", checkpointRubric: "", masterySignals: [], misconceptionSignals: [], remediationStrategy: "" };
const coursePlan = { id: "course", title: "Source", subtitle: "", audience: "general", estimatedTimeMinutes: 10, modules: [module] };
const candidate = {
  role: "제도적 통제에서 자율성으로 이어지는 추론", difficulty: "통제와 강제의 범위 차이",
  steps: [
    { purpose: "전제", instruction: "강제된 행위에 관한 전제를 설명한다.", status: "source", evidence: [{ chunkId: "a", quote: "Coerced action is not autonomous." }] },
    { purpose: "구분", instruction: "통제가 언제 강제가 되는지 재구성한다.", status: "interpretation", evidence: [{ chunkId: "a", quote: "Institutional control can constrain autonomous action." }] },
    { purpose: "한계", instruction: "가능성을 필연성으로 바꾸지 않는다.", status: "interpretation", evidence: [{ chunkId: "a", quote: "can constrain autonomous action" }] },
  ],
  connections: [{ targetChunkId: "b", kind: "limitation", explanation: "통제와 강제가 항상 같지는 않다는 제한", evidence: [{ chunkId: "a", quote: "Institutional control can constrain autonomous action." }, { chunkId: "b", quote: "Institutional control does not always amount to coercion." }] }],
  explorations: ["통제와 강제를 구분해줘", "이 추론에 필요한 전제를 풀어줘", "뒤의 제한과 연결해줘"],
};

async function fixture() {
  const ir = await compileLearningIr({ materialId: "material", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: [] });
  const deepReading = await compileDeepReading({ chunks, ir, runtime: { model: "fixture", client: {
    listModels: async () => [], chatText: async () => "", chatJson: async () => candidate,
  } } });
  const artifacts: MaterialArtifacts = {
    manifest: { id: "material", projectId: "project", title: "Source", sourceIds: ["source"], sourceChunkIds: chunks.map((chunk) => chunk.id), generatedAt: "now", generatorModel: "fixture", status: "ready" },
    overview: { paragraph: "Source", sourceChunkIds: ["a"], generatedAt: "now", generatorVersion: "fixture" },
    coursePlan, sourceChunks: chunks, sourceSemanticIr: ir, lecturePlan: { materialId: "material", generatedAt: "now", modules: [], deepReading },
    conceptMap: [], visuals: [], sourceIndex: {}, figures: [], figureIndex: {}, annotations: [],
  };
  return { artifacts, ir, deepReading };
}

describe("deep reading evidence and planning", () => {
  test("locates exact excerpts, rejecting fabricated or out-of-scope evidence", () => {
    const evidence = validatePassageEvidence([{ chunkId: "a", quote: "Coerced action is not autonomous." }, { chunkId: "a", quote: "Control always eliminates autonomy." }, { chunkId: "missing", quote: chunks[0]!.text }], chunks);
    expect(evidence).toHaveLength(1);
    expect(chunks[0]!.text.slice(evidence[0]!.startOffset, evidence[0]!.endOffset)).toBe(evidence[0]!.quote);
    expect(validatePassageEvidence(evidence, chunks, new Set(["b"]))).toEqual([]);
    expect(validateExplanationGrounding({ status: "source", evidence: [{ chunkId: "a", quote: "made up" }] }, chunks, new Set(["a"]))?.status).toBe("uncertain");
  });

  test("requires evidence on both sides of a remote connection", () => {
    const plan = normalizePassagePlan(candidate, chunks[0]!, chunks);
    expect(plan.connections).toHaveLength(1);
    expect(plan.teachingTurns).toBe(2);
    const broken = structuredClone(candidate);
    broken.connections[0]!.evidence.pop();
    expect(normalizePassagePlan(broken, chunks[0]!, chunks).connections).toEqual([]);
  });

  test("malformed model output degrades without invented analysis", () => {
    for (const value of [null, [], { steps: "invalid" }, { role: 42, steps: [{ instruction: {}, evidence: null }] }]) {
      expect(normalizePassagePlan(value, chunks[0]!, chunks).status).toBe("fallback");
    }
  });

  test("records truncated analysis and cannot cite the omitted suffix", () => {
    const supplied = [{ ...chunks[0]!, text: chunks[0]!.text.slice(0, 33) }];
    const plan = normalizePassagePlan(candidate, chunks[0]!, supplied);
    expect(plan.status).toBe("analyzed");
    expect(plan.steps).toHaveLength(1);
    expect(plan.limitation).toContain("33");
    expect(plan.analyzedCharacters).toBe(33);
  });

  test("retries a truncated plan once with a shorter-plan request", async () => {
    const { ir } = await fixture();
    const calls: Array<{ maxTokens?: number; last: string }> = [];
    let failedOnce = false;
    const plan = await compileDeepReading({ chunks: [chunks[0]!], ir, runtime: { model: "fixture", client: {
      listModels: async () => [], chatText: async () => "",
      chatJson: async (params) => {
        calls.push({ maxTokens: params.maxTokens, last: params.messages.at(-1)!.content });
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("Ollama Cloud fixture stopped before finishing because it hit the output token limit (finish_reason=length)");
        }
        return candidate;
      },
    } } });
    expect(plan.passages[0]!.status).toBe("analyzed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.maxTokens).toBeGreaterThan(2600);
    expect(calls[1]!.last).toContain("shorter plan");
  });

  test("falls back without retrying on errors other than the output limit", async () => {
    const { ir } = await fixture();
    let calls = 0;
    const plan = await compileDeepReading({ chunks: [chunks[0]!], ir, runtime: { model: "fixture", client: {
      listModels: async () => [], chatText: async () => "",
      chatJson: async () => { calls += 1; throw new Error("network down"); },
    } } });
    expect(plan.passages[0]!.status).toBe("fallback");
    expect(calls).toBe(1);
  });

  test("records unavailable models per passage and completes progress", async () => {
    const { ir } = await fixture();
    const progress: number[] = [];
    const plan = await compileDeepReading({ chunks, ir, onProgress: (completed) => progress.push(completed) });
    expect(plan.passages.every((passage) => passage.status === "fallback")).toBe(true);
    expect(progress.at(-1)).toBe(chunks.length);
  });

  test("repairs reader assignments once and never loops on invalid plans", async () => {
    const { ir } = await fixture();
    const assignment = structuredClone(candidate);
    assignment.steps[0]!.instruction = "전제를 찾아 적으세요";
    expect(normalizePassagePlan(assignment, chunks[0]!, chunks).status).toBe("fallback");
    let calls = 0;
    const client = { listModels: async () => [], chatText: async () => "", chatJson: async () => ++calls === 1 ? assignment : candidate };
    const repaired = await compileDeepReading({ chunks: [chunks[0]!], ir, runtime: { model: "fixture", client } });
    expect(calls).toBe(2);
    expect(repaired.passages[0]!.status).toBe("analyzed");
    calls = 0;
    client.chatJson = async () => { calls += 1; return assignment; };
    const rejected = await compileDeepReading({ chunks: [chunks[0]!], ir, runtime: { model: "fixture", client } });
    expect(calls).toBe(2);
    expect(rejected.passages[0]!.status).toBe("fallback");
  });

  test("invalidates plans on same-length source edits, locator changes and plan tampering", async () => {
    const { artifacts } = await fixture();
    expect(currentDeepReading(artifacts)).toBeDefined();
    const edited = structuredClone(artifacts);
    edited.sourceChunks[0]!.text = edited.sourceChunks[0]!.text.replace("Coerced", "Planned");
    expect(currentDeepReading(edited)).toBeUndefined();
    expect(passagePlanFor(edited, "a")).toBeUndefined();
    const relocated = structuredClone(artifacts);
    relocated.sourceChunks[0]!.locator = "p. 100";
    expect(currentDeepReading(relocated)).toBeUndefined();
    const tampered = structuredClone(artifacts);
    tampered.lecturePlan!.deepReading!.passages[0]!.role = "Changed";
    expect(currentDeepReading(tampered)).toBeUndefined();
  });

  test("Korean questions retrieve a linked English limitation without moving progress", async () => {
    const { artifacts } = await fixture();
    const before = JSON.stringify(artifacts);
    const context = readingContextChunks(artifacts, "a", "이 주장의 한계와 조건을 설명해줘");
    expect(context[0]!.id).toBe("a");
    expect(context.map((chunk) => chunk.id)).toContain("b");
    expect(JSON.stringify(artifacts)).toBe(before);
    expect(estimateInitialMessageSetSize(chunks, artifacts)).toBe(5);
  });
});

describe("tutor integration", () => {
  test("keeps excerpt metadata through prose splitting and never counts remote evidence as teaching", async () => {
    const { artifacts } = await fixture();
    const service = new TutorService() as unknown as {
      sanitizeOutput: (artifacts: MaterialArtifacts, module: typeof coursePlan.modules[number], focus: SourceChunk, session: SessionSnapshot, payload: { event: "continue_chunk" }, output: Partial<TutorTurnOutput>) => TutorTurnOutput;
      messageTeachingChunkRefs: (message: TutorMessage) => string[];
      materialFingerprint: (artifacts: MaterialArtifacts) => string;
    };
    const session: SessionSnapshot = { id: "s", projectId: "p", materialId: "material", title: "Source", status: "active", currentModuleId: "m", completedModuleIds: [], currentChunkId: "a", coveredChunkIds: [], model: "fixture", messageSetId: null, lastRevealedRouteIndex: -1, lastRevealedMessageId: null, messages: [], createdAt: 0, updatedAt: 0 };
    const blocks: TutorContentBlock[] = [{ type: "paragraph", body: "통제와 강제가 언제 같은 의미인지 조건을 나누어 살펴보겠습니다. ".repeat(20), grounding: { status: "interpretation", evidence: validatePassageEvidence(candidate.connections[0]!.evidence, chunks) } }];
    const output = service.sanitizeOutput(artifacts, module, chunks[0]!, session, { event: "continue_chunk" }, { blocks, message: "설명", sourceRefs: ["b"] });
    expect(output.sourceRefs).toEqual(["a", "b"]);
    expect(output.blocks!.length).toBeGreaterThan(1);
    expect(output.blocks!.every((block) => block.grounding?.status === "interpretation")).toBe(true);
    expect(service.messageTeachingChunkRefs({ id: "msg", role: "assistant", content: output.message, sourceRefs: output.sourceRefs, choices: [], blocks: output.blocks, createdAt: 0, ordinal: 0 })).toEqual(["a"]);
    expect(session.currentChunkId).toBe("a");
    expect(session.coveredChunkIds).toEqual([]);
    const modified = structuredClone(artifacts);
    modified.sourceChunks[0]!.text = modified.sourceChunks[0]!.text.replace("Coerced", "Planned");
    expect(service.materialFingerprint(modified)).not.toBe(service.materialFingerprint(artifacts));
  });
});

describe("relations and conversation recall", () => {
  test("draws only actual edges, retaining relation direction and meaning", async () => {
    const { ir } = await fixture();
    ir.sections[0]!.kind = "argument_reconstruction";
    ir.claims = [{ id: "p", statement: "Premise", role: "premise", sourceChunkIds: ["a"] }, { id: "q", statement: "Conclusion", role: "conclusion", sourceChunkIds: ["a"] }];
    ir.sections[0]!.claimIds = ["p", "q"];
    expect(buildGroundedVisuals(ir, [])).toEqual([]);
    ir.relations = [{ id: "r", fromId: "q", toId: "p", type: "challenges", sourceChunkIds: ["a"] }];
    const visual = buildGroundedVisuals(ir, [])[0]!;
    expect(visual.type).toBe("relations");
    if (visual.type !== "relations") throw new Error("Expected relation visual");
    expect(visual.edges[0]).toMatchObject({ from: "q", to: "p", label: "반박·제한" });
  });

  test("recalls original exchanges with IDs, within a bounded budget", () => {
    const messages = [{ id: "u1", role: "user", content: "autonomy와 coercion의 차이를 설명해줘" }, { id: "a1", role: "assistant", content: "x".repeat(4000) }, ...Array.from({ length: 8 }, (_, index) => ({ id: `recent-${index}`, role: "assistant", content: "recent" }))];
    const recalled = recallConversation(messages, "coercion을 다시 설명해줘");
    expect(recalled).toContain("[u1]");
    expect(recalled).toContain("[a1]");
    expect(recalled).not.toContain("recent-");
    expect(recalled.length).toBeLessThan(2800);
    expect(recallConversation(messages, "membrane")).toBe("");
  });
});
