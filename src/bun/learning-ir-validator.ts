import { createHash } from "node:crypto";
import type { SourceChunk } from "../shared/artifact-types";
import {
  LEARNING_IR_SCHEMA_VERSION,
  type ArtifactIssueCode,
  type ArtifactQualityIssue,
  type ArtifactQualitySummary,
  type LearningConcept,
  type SourceSemanticIr,
  type LearningRelation,
  type LearningSectionIr,
} from "../shared/learning-ir-types";

const UNSAFE_TEXT = /<\/?(?:script|iframe|object|embed|svg|html)\b|(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\.\.\/)/i;
const MAX_SECTIONS = 240;
const MAX_CONCEPTS = 96;
const MAX_CLAIMS = 192;
const MAX_RELATIONS = 192;
const SECTION_KINDS = new Set(["expository_conceptual", "historical_narrative", "argument_reconstruction", "comparative", "procedural_technical", "causal_mechanism", "quantitative"]);
const VISUAL_KINDS = new Set(["argument_map", "relationship_graph", "tree", "cycle", "flow", "formula", "contrast", "layers", "timeline", "axis", "matrix", "annotated_table"]);
const CLAIM_ROLES = new Set(["thesis", "premise", "evidence", "counterclaim", "conclusion", "definition", "event", "mechanism", "step"]);
const RELATION_TYPES = new Set(["supports", "challenges", "causes", "enables", "contrasts_with", "part_of", "precedes", "prerequisite_for", "explains"]);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function learningIrContentHash(ir: Omit<SourceSemanticIr, "contentHash"> | SourceSemanticIr) {
  const { contentHash: _contentHash, generatedAt: _generatedAt, quality: _quality, ...semantic } = ir as SourceSemanticIr;
  return sha256(semantic);
}

function issue(code: ArtifactIssueCode, message: string, itemId?: string): ArtifactQualityIssue {
  return { code, stage: "ir", itemId, message };
}

function safeText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > max || UNSAFE_TEXT.test(normalized)) return null;
  return normalized;
}

function validRefs(refs: unknown, validChunkIds: Set<string>) {
  if (!Array.isArray(refs)) return [];
  return [...new Set(refs.filter((id): id is string => typeof id === "string" && validChunkIds.has(id)))];
}

function normalizedConceptKey(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeConcepts(concepts: LearningConcept[], issues: ArtifactQualityIssue[]) {
  const byKey = new Map<string, LearningConcept>();
  for (const concept of concepts) {
    const key = normalizedConceptKey(concept.label);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, concept);
      continue;
    }
    const overlap = concept.sourceChunkIds.some((id) => existing.sourceChunkIds.includes(id));
    if (!overlap) {
      byKey.set(`${key}\u0000${concept.id}`, concept);
      continue;
    }
    issues.push(issue("duplicate_concept", `Merged duplicate concept ${concept.label}.`, concept.id));
    existing.sourceChunkIds = [...new Set([...existing.sourceChunkIds, ...concept.sourceChunkIds])];
  }
  return [...byKey.values()];
}

function removePrerequisiteCycles(relations: LearningRelation[], issues: ArtifactQualityIssue[]) {
  const accepted: LearningRelation[] = [];
  const adjacency = new Map<string, Set<string>>();
  const reaches = (start: string, target: string) => {
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...(adjacency.get(current) || []));
    }
    return false;
  };
  for (const relation of relations) {
    if (relation.type !== "prerequisite_for") {
      accepted.push(relation);
      continue;
    }
    if (relation.fromId === relation.toId || reaches(relation.toId, relation.fromId)) {
      issues.push(issue("prerequisite_cycle", "Removed a prerequisite edge that introduced a cycle.", relation.id));
      continue;
    }
    const outgoing = adjacency.get(relation.fromId) || new Set<string>();
    outgoing.add(relation.toId);
    adjacency.set(relation.fromId, outgoing);
    accepted.push(relation);
  }
  return accepted;
}

function quality(issues: ArtifactQualityIssue[], accepted: number, rejected: number, forcedDegraded = false): ArtifactQualitySummary {
  return {
    status: forcedDegraded || accepted === 0 ? "degraded" : issues.length ? "warning" : "good",
    issues,
    acceptedItemCount: accepted,
    rejectedItemCount: rejected,
  };
}

export type LearningIrValidationInput = Omit<SourceSemanticIr, "contentHash" | "quality"> & {
  contentHash?: string;
  quality?: ArtifactQualitySummary;
};

export function validateLearningIr(candidate: LearningIrValidationInput, chunks: SourceChunk[]): SourceSemanticIr {
  const issues: ArtifactQualityIssue[] = [];
  let rejected = 0;
  const validChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const sourceHeadings = new Set(chunks.flatMap((chunk) => chunk.headingPath).map((heading) => normalizedConceptKey(heading)));
  const sections: LearningSectionIr[] = [];
  const globalIds = new Set<string>();

  for (const raw of Array.isArray(candidate.sections) ? candidate.sections.slice(0, MAX_SECTIONS) : []) {
    const title = safeText(raw.title, 240);
    const refs = validRefs(raw.sourceChunkIds, validChunkIds);
    if (!raw.id || globalIds.has(raw.id) || !raw.moduleId || !title || !refs.length || !SECTION_KINDS.has(raw.kind)) {
      issues.push(issue(!refs.length ? "missing_chunk_ref" : "invalid_schema", "Rejected an invalid learning section.", raw.id));
      rejected += 1;
      continue;
    }
    globalIds.add(raw.id);
    sections.push({
      ...raw,
      title,
      sourceChunkIds: refs,
      conceptIds: [],
      claimIds: [],
      relationIds: [],
      visualCandidateKinds: Array.isArray(raw.visualCandidateKinds) ? raw.visualCandidateKinds.filter((kind) => VISUAL_KINDS.has(kind)) : [],
    });
  }

  const concepts = dedupeConcepts(
    (Array.isArray(candidate.concepts) ? candidate.concepts.slice(0, MAX_CONCEPTS) : []).flatMap((raw) => {
      const label = safeText(raw.label, 120);
      const definition = safeText(raw.definition, 600);
      const whyItMatters = safeText(raw.whyItMatters, 600);
      const refs = validRefs(raw.sourceChunkIds, validChunkIds);
      const structuralLabel = Boolean(label && (sourceHeadings.has(normalizedConceptKey(label)) || /^(?:figure|fig\.?|table|chapter|section)\b/i.test(label)));
      const genericSignificance = Boolean(whyItMatters && /(?:later questions?|core context|important context|basis for (?:later|subsequent)|이후 질문|핵심 문맥|근거가 되는)/i.test(whyItMatters));
      if (!raw.id || globalIds.has(raw.id) || !label || !definition || !whyItMatters || !refs.length || structuralLabel || genericSignificance) {
        issues.push(issue(!refs.length ? "missing_chunk_ref" : UNSAFE_TEXT.test(String(raw.label || raw.definition || "")) ? "unsafe_content" : "invalid_schema", "Rejected an invalid concept.", raw.id));
        rejected += 1;
        return [];
      }
      globalIds.add(raw.id);
      return [{ ...raw, label, definition, whyItMatters, sourceChunkIds: refs }];
    }),
    issues,
  );
  const conceptIds = new Set(concepts.map((item) => item.id));

  const claims = (Array.isArray(candidate.claims) ? candidate.claims.slice(0, MAX_CLAIMS) : []).flatMap((raw) => {
    const statement = safeText(raw.statement, 900);
    const refs = validRefs(raw.sourceChunkIds, validChunkIds);
    if (!raw.id || globalIds.has(raw.id) || !statement || !refs.length || !CLAIM_ROLES.has(raw.role)) {
      issues.push(issue(!refs.length ? "missing_chunk_ref" : UNSAFE_TEXT.test(String(raw.statement || "")) ? "unsafe_content" : "invalid_schema", "Rejected an invalid claim.", raw.id));
      rejected += 1;
      return [];
    }
    globalIds.add(raw.id);
    return [{ ...raw, statement, sourceChunkIds: refs }];
  });
  const claimIds = new Set(claims.map((item) => item.id));
  const nodeIds = new Set([...conceptIds, ...claimIds]);
  const relationKeys = new Set<string>();
  const relations = removePrerequisiteCycles(
    (Array.isArray(candidate.relations) ? candidate.relations.slice(0, MAX_RELATIONS) : []).flatMap((raw) => {
      const refs = validRefs(raw.sourceChunkIds, validChunkIds);
      const label = raw.label == null ? undefined : safeText(raw.label, 160) || undefined;
      const key = `${raw.fromId}\u0000${raw.toId}\u0000${raw.type}`;
      if (!raw.id || globalIds.has(raw.id) || !nodeIds.has(raw.fromId) || !nodeIds.has(raw.toId) || !refs.length || relationKeys.has(key) || !RELATION_TYPES.has(raw.type)) {
        issues.push(issue(!refs.length ? "missing_chunk_ref" : !nodeIds.has(raw.fromId) || !nodeIds.has(raw.toId) ? "orphan_node" : "invalid_edge", "Rejected an invalid or duplicate relation.", raw.id));
        rejected += 1;
        return [];
      }
      relationKeys.add(key);
      globalIds.add(raw.id);
      return [{ ...raw, label, sourceChunkIds: refs }];
    }),
    issues,
  );

  for (const section of sections) {
    const overlaps = (refs: string[]) => refs.some((id) => section.sourceChunkIds.includes(id));
    section.conceptIds = concepts.filter((item) => overlaps(item.sourceChunkIds)).map((item) => item.id);
    section.claimIds = claims.filter((item) => overlaps(item.sourceChunkIds)).map((item) => item.id);
    section.relationIds = relations.filter((item) => overlaps(item.sourceChunkIds)).map((item) => item.id);
  }

  if ((candidate.sections?.length || 0) > MAX_SECTIONS || (candidate.concepts?.length || 0) > MAX_CONCEPTS || (candidate.claims?.length || 0) > MAX_CLAIMS || (candidate.relations?.length || 0) > MAX_RELATIONS) {
    issues.push(issue("oversize", "Artifact items were truncated to bounded graph limits."));
  }
  const accepted = sections.length + concepts.length + claims.length + relations.length;
  const withoutHash: Omit<SourceSemanticIr, "contentHash"> = {
    schemaVersion: LEARNING_IR_SCHEMA_VERSION,
    materialId: candidate.materialId,
    documentType: candidate.documentType,
    sourceFingerprint: candidate.sourceFingerprint,
    generatedAt: candidate.generatedAt,
    generator: candidate.generator,
    sections,
    concepts,
    claims,
    relations,
    quality: quality(issues, accepted, rejected, concepts.length < 2),
  };
  return { ...withoutHash, contentHash: learningIrContentHash(withoutHash) };
}
