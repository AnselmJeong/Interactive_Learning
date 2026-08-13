import type { MaterialOverview, SourceChunk } from "../shared/artifact-types";
import type { ArtifactQualityIssue, SourceBrief, SourceSemanticIr } from "../shared/learning-ir-types";

export const SOURCE_BRIEF_GENERATOR_VERSION = "source-brief-v1";

function compact(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function anchorIndexes(length: number, count: number) {
  if (length <= count) return Array.from({ length }, (_, index) => index);
  const indexes = new Set<number>();
  for (let index = 0; index < count; index += 1) indexes.add(Math.round((index * (length - 1)) / (count - 1)));
  return [...indexes].sort((left, right) => left - right);
}

function anchorLabel(chunk: SourceChunk, index: number) {
  return compact(chunk.headingPath.at(-1) || chunk.locator || `대목 ${index + 1}`, 100);
}

function guidingQuestion(title: string, centralLabel?: string) {
  const subject = centralLabel || title;
  return compact(`${subject}은(는) 이 자료의 핵심 문제와 어떻게 연결되는가?`, 120);
}

export type CompileSourceBriefInput = {
  ir: SourceSemanticIr;
  title: string;
  sourceCount: number;
  chunks: SourceChunk[];
  overview?: MaterialOverview | null;
};

export function compileSourceBrief(input: CompileSourceBriefInput): SourceBrief {
  const issues: ArtifactQualityIssue[] = [];
  const conceptIds = input.ir.concepts.slice(0, 6).map((concept) => concept.id);
  if (conceptIds.length < 4) {
    issues.push({ code: "invalid_schema", stage: "brief", message: "The source exposes fewer than four grounded concepts." });
  }
  const anchorCount = Math.min(6, Math.max(3, input.chunks.length));
  const anchors = anchorIndexes(input.chunks.length, anchorCount).map((index) => {
    const chunk = input.chunks[index]!;
    return { sourceChunkId: chunk.id, label: anchorLabel(chunk, index), excerpt: compact(chunk.text, 240) };
  });
  const firstConcept = input.ir.concepts[0];
  const isArticle = input.ir.documentType === "article";
  const summary = compact(input.overview?.paragraph || firstConcept?.definition || input.title, 1_200);
  const centralIdea = isArticle
    ? null
    : compact(input.ir.claims.find((claim) => claim.role === "thesis" || claim.role === "conclusion")?.statement || "", 500) || null;
  const rejectedItemCount = input.ir.quality.rejectedItemCount;
  return {
    schemaVersion: 1,
    materialId: input.ir.materialId,
    scope: input.sourceCount > 1 ? "multi_source" : "single_source",
    documentType: input.ir.documentType,
    guidingQuestion: guidingQuestion(input.title, firstConcept?.label),
    summary,
    centralIdea,
    conceptIds,
    structureVisualId: null,
    misconceptions: [],
    anchors,
    reviewPrompt: {
      prompt: firstConcept
        ? `${firstConcept.label}이(가) 다른 핵심 개념과 어떤 관계인지 자신의 말로 연결해 보세요.`
        : "이 자료의 중심 질문과 전개 방식을 자신의 말로 연결해 보세요.",
      kind: "connect",
    },
    sourceFingerprint: input.ir.sourceFingerprint,
    generatedAt: input.ir.generatedAt,
    generatorVersion: SOURCE_BRIEF_GENERATOR_VERSION,
    quality: {
      status: input.ir.quality.status === "degraded" || conceptIds.length < 2 ? "degraded" : issues.length || input.ir.quality.status === "warning" ? "warning" : "good",
      issues: [...input.ir.quality.issues, ...issues],
      acceptedItemCount: conceptIds.length + anchors.length + (summary ? 1 : 0),
      rejectedItemCount,
    },
  };
}

export function sourceBriefAsLegacyOverview(brief: SourceBrief): MaterialOverview {
  return {
    paragraph: brief.summary,
    sourceChunkIds: brief.anchors.map((anchor) => anchor.sourceChunkId),
    generatedAt: brief.generatedAt,
    generatorVersion: brief.generatorVersion,
  };
}
