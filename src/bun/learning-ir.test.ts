import { describe, expect, test } from "bun:test";
import type { Concept, CoursePlan, SourceChunk } from "../shared/artifact-types";
import { compileLearningIr, learningSourceFingerprint, stableLearningId } from "./learning-ir-compiler";
import { validateLearningIr } from "./learning-ir-validator";
import { compileSourceBrief } from "./source-brief-compiler";
import { buildGroundedVisuals } from "./visual-grammar";

const chunks: SourceChunk[] = [
  { id: "chunk-1", headingPath: ["Problem"], locator: "p. 1", kind: "body", text: "The argument begins with a premise about social recognition.", confidence: 1 },
  { id: "chunk-2", headingPath: ["Response"], locator: "p. 2", kind: "body", text: "A counterclaim contrasts recognition with autonomy and supports a different conclusion.", confidence: 1 },
  { id: "chunk-3", headingPath: ["Method"], locator: "p. 3", kind: "body", text: "First the researcher compares the cases, then explains the mechanism.", confidence: 1 },
];

const concepts: Concept[] = chunks.map((chunk, index) => ({
  id: `legacy-${index}`,
  name: chunk.headingPath[0]!,
  definition: chunk.text,
  whyItMatters: `Why ${chunk.headingPath[0]} matters`,
  prerequisites: [],
  misconceptions: [],
  sourceChunkIds: [chunk.id],
}));

const coursePlan: CoursePlan = {
  id: "course-1",
  title: "Argument",
  subtitle: "",
  audience: "general",
  estimatedTimeMinutes: 20,
  modules: chunks.map((chunk, index) => ({
    id: `module-${index + 1}`,
    title: chunk.headingPath[0]!,
    learningGoal: `Understand ${chunk.headingPath[0]}`,
    conceptIds: [concepts[index]!.id],
    sourceChunkIds: [chunk.id],
    visualIds: [],
    hookIntent: "",
    checkpointRubric: "",
    masterySignals: [],
    misconceptionSignals: [],
    remediationStrategy: "",
  })),
};

describe("learning IR compiler", () => {
  test("keeps stable IDs, source fingerprints, and content hashes for identical semantic input", async () => {
    const input = { materialId: "material-1", documentType: "book" as const, sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts, generatedAt: "2026-08-13T00:00:00.000Z" };
    const first = await compileLearningIr(input);
    const second = await compileLearningIr(input);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.concepts.map((item) => item.id)).toEqual(second.concepts.map((item) => item.id));
    expect(stableLearningId("concept", "material-1", "module-1", ["chunk-1"], "  Problem ")).toBe(
      stableLearningId("concept", "material-1", "module-1", ["chunk-1"], "problem"),
    );
    expect(learningSourceFingerprint(chunks, "book")).not.toBe(learningSourceFingerprint([...chunks].reverse(), "book"));
  });

  test("does not manufacture concepts or relations without an AI runtime", async () => {
    const ir = await compileLearningIr({ materialId: "material-1", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts });
    expect(ir.sections).toHaveLength(3);
    expect(ir.concepts).toEqual([]);
    expect(ir.relations).toEqual([]);
    expect(ir.quality.status).toBe("degraded");
    expect(ir.generator.model).toBe("deterministic-fallback");
  });
});

describe("learning IR validator", () => {
  test("removes missing references and prerequisite cycles but permits causal cycles", async () => {
    const ir = await compileLearningIr({ materialId: "material-1", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts });
    const left = { id: "recognition", label: "Social recognition", definition: "A response that confers standing.", whyItMatters: "It changes which actions are socially available.", sourceChunkIds: ["chunk-1"] };
    const right = { id: "autonomy", label: "Autonomy", definition: "The capacity for self-directed action.", whyItMatters: "It provides the contrasting account of agency.", sourceChunkIds: ["chunk-2"] };
    const validated = validateLearningIr({
      ...ir,
      concepts: [left, right, { ...left, id: "bad", sourceChunkIds: ["missing"] }],
      relations: [
        { id: "pre-1", fromId: left.id, toId: right.id, type: "prerequisite_for", sourceChunkIds: ["chunk-1"] },
        { id: "pre-2", fromId: right.id, toId: left.id, type: "prerequisite_for", sourceChunkIds: ["chunk-2"] },
        { id: "cause-1", fromId: left.id, toId: right.id, type: "causes", sourceChunkIds: ["chunk-1"] },
        { id: "cause-2", fromId: right.id, toId: left.id, type: "causes", sourceChunkIds: ["chunk-2"] },
      ],
    }, chunks);
    expect(validated.concepts.some((item) => item.id === "bad")).toBe(false);
    expect(validated.relations.filter((item) => item.type === "prerequisite_for")).toHaveLength(1);
    expect(validated.relations.filter((item) => item.type === "causes")).toHaveLength(2);
    expect(validated.quality.issues.map((item) => item.code)).toContain("missing_chunk_ref");
    expect(validated.quality.issues.map((item) => item.code)).toContain("prerequisite_cycle");
  });

  test("enforces runtime enum allowlists and global ID uniqueness", async () => {
    const ir = await compileLearningIr({ materialId: "material-1", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts });
    const duplicatedId = ir.sections[0]!.id;
    const validated = validateLearningIr({
      ...ir,
      concepts: [
        ...ir.concepts,
        { id: duplicatedId, label: "Duplicate", definition: "Duplicate", whyItMatters: "Duplicate", sourceChunkIds: ["chunk-1"] },
      ],
      claims: [
        ...ir.claims,
        { id: "invalid-role", role: "invented" as never, statement: "Invalid", sourceChunkIds: ["chunk-1"] },
      ],
    }, chunks);
    expect(validated.concepts.some((item) => item.id === duplicatedId)).toBe(false);
    expect(validated.claims.some((item) => item.id === "invalid-role")).toBe(false);
  });
});

describe("learning artifact projections", () => {
  test("builds real source anchors and keeps article central results out of the brief", async () => {
    const ir = await compileLearningIr({ materialId: "material-1", documentType: "article", sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts });
    const brief = compileSourceBrief({ ir, title: "Study", sourceCount: 1, chunks, overview: { paragraph: "This study introduces its topic, problem, background, and approach.", sourceChunkIds: chunks.map((item) => item.id), generatedAt: "now", generatorVersion: "test" } });
    expect(brief.centralIdea).toBeNull();
    expect(brief.anchors.map((item) => item.sourceChunkId)).toEqual(chunks.map((item) => item.id));
    expect(brief.anchors.every((item) => item.excerpt.length <= 240)).toBe(true);
  });

  test("does not invent a generated visual when deterministic source analysis has no semantic nodes", async () => {
    const ir = await compileLearningIr({ materialId: "material-1", documentType: "book", sourceCount: 1, chunks, coursePlan, legacyConcepts: concepts });
    const section = ir.sections[0]!;
    const withoutFigure = buildGroundedVisuals(ir, []);
    const withFigure = buildGroundedVisuals(ir, [{ id: "figure-1", sourceId: "source-1", title: "Figure", assetPath: "/tmp/figure.png", assetUrl: "asset://figure", mimeType: "image/png", caption: null, captionStatus: "none", width: 100, height: 100, locator: "p. 1", sourceChunkIds: [section.sourceChunkIds[0]!] }]);
    expect(withoutFigure.some((item) => item.sectionId === section.id)).toBe(false);
    expect(withFigure.some((item) => item.sectionId === section.id)).toBe(false);
  });
});
