import type { AiChatClient } from "./openai-compatible-client";
import type { Concept, CourseModule, CoursePlan, SourceChunk } from "../shared/artifact-types";
import {
  LEARNING_IR_COMPILER_VERSION,
  LEARNING_IR_PROMPT_VERSION,
  LEARNING_IR_SCHEMA_VERSION,
  type LearningClaim,
  type LearningClaimRole,
  type LearningConcept,
  type LearningDocumentType,
  type SourceSemanticIr,
  type LearningRelation,
  type LearningRelationType,
  type LearningSectionKind,
  type VisualGrammarKind,
} from "../shared/learning-ir-types";
import { canonicalJson, sha256, validateLearningIr } from "./learning-ir-validator";

const MAX_BATCH_CHARACTERS = 24_000;

export type LearningIrRuntime = {
  client: AiChatClient;
  model: string;
};

type CandidateConcept = { key: string; label: string; definition: string; whyItMatters: string; sourceChunkIds: string[] };
type CandidateClaim = { key: string; role: LearningClaimRole; statement: string; sourceChunkIds: string[] };
type CandidateRelation = { fromKey: string; toKey: string; type: LearningRelationType; label?: string; sourceChunkIds: string[] };
type CandidateFragment = {
  kind?: LearningSectionKind;
  concepts?: CandidateConcept[];
  claims?: CandidateClaim[];
  relations?: CandidateRelation[];
};

function normalizedIdentity(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function stableLearningId(prefix: string, materialId: string, moduleId: string, sourceChunkIds: string[], identity: string) {
  const canonicalRefs = [...new Set(sourceChunkIds)].sort();
  return `${prefix}-${sha256([materialId, moduleId, canonicalRefs, normalizedIdentity(identity)]).slice(0, 20)}`;
}

export function learningSourceFingerprint(
  chunks: SourceChunk[],
  documentType: LearningDocumentType,
  compilerVersion = LEARNING_IR_COMPILER_VERSION,
  promptVersion = LEARNING_IR_PROMPT_VERSION,
) {
  return sha256({
    orderedChunks: chunks.map((chunk) => ({ id: chunk.id, textHash: sha256(chunk.text), locator: chunk.locator })),
    documentType,
    compilerVersion,
    promptVersion,
  });
}

function firstSentence(text: string, max = 360) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] || normalized;
  return sentence.slice(0, max).trim();
}

function sectionKind(text: string): LearningSectionKind {
  const value = text.toLocaleLowerCase();
  if (/\b(versus|compared|comparison|contrast|whereas)\b|비교|대조|반면/.test(value)) return "comparative";
  if (/\b(because|cause|effect|mechanism|leads to)\b|원인|결과|기제|메커니즘|때문/.test(value)) return "causal_mechanism";
  if (/\b(first|second|then|procedure|step|method)\b|단계|절차|방법|순서/.test(value)) return "procedural_technical";
  if (/\b(thesis|premise|argument|objection|conclusion)\b|논증|전제|반론|결론|주장/.test(value)) return "argument_reconstruction";
  if (/\b(year|century|history|historical|war|reign)\b|세기|역사|전쟁|시대|연대/.test(value)) return "historical_narrative";
  if (/\b(equation|formula|variable|percent|ratio|statistic)\b|공식|변수|비율|통계|수식/.test(value)) return "quantitative";
  return "expository_conceptual";
}

export function visualCandidatesForSection(kind: LearningSectionKind): VisualGrammarKind[] {
  const mapping: Record<LearningSectionKind, VisualGrammarKind[]> = {
    argument_reconstruction: ["argument_map", "flow"],
    historical_narrative: ["timeline", "relationship_graph"],
    causal_mechanism: ["flow", "cycle", "layers"],
    comparative: ["contrast", "matrix", "annotated_table", "axis"],
    procedural_technical: ["flow", "annotated_table"],
    expository_conceptual: ["relationship_graph", "layers", "contrast"],
    quantitative: ["formula", "axis", "annotated_table"],
  };
  return mapping[kind];
}

function moduleChunks(module: CourseModule, chunksById: Map<string, SourceChunk>) {
  return module.sourceChunkIds.map((id) => chunksById.get(id)).filter((chunk): chunk is SourceChunk => Boolean(chunk));
}

function fallbackFragment(module: CourseModule, chunks: SourceChunk[], legacyConcepts: Concept[]): CandidateFragment {
  const text = chunks.map((chunk) => chunk.text).join("\n");
  void legacyConcepts;
  return {
    kind: sectionKind(`${module.title}\n${text}`),
    concepts: [],
    claims: [],
    relations: [],
  };
}

function fragmentPrompt(module: CourseModule, chunks: SourceChunk[]) {
  const source = chunks.map((chunk) => `[${chunk.id} | ${chunk.locator}]\n${chunk.text}`).join("\n\n").slice(0, MAX_BATCH_CHARACTERS);
  return {
    system: [
      "Extract a compact, source-grounded learning graph from the supplied section.",
      "A concept must be a domain entity, model, mechanism, process, variable, or distinction needed to express the section's claims.",
      "Section and chapter titles, introductory paragraphs, quotations, figures, captions, and headings are metadata or evidence, never concepts.",
      "Do not turn the first sentence into a concept by default. Omit concepts and relations that are not explicitly supported.",
      "whyItMatters must name the specific explanatory role of this concept; generic importance or future-question language is invalid.",
      "Return one JSON object with kind, concepts, claims, and relations.",
      "Every item must use only sourceChunkIds printed in the input. Use short local keys such as c1 or p1; never create UUIDs.",
      "Keep the source language. Do not return HTML, URLs, file paths, SVG, Mermaid, CSS, or coordinates.",
      "Kinds: expository_conceptual, historical_narrative, argument_reconstruction, comparative, procedural_technical, causal_mechanism, quantitative.",
      "Claim roles: thesis, premise, evidence, counterclaim, conclusion, definition, event, mechanism, step.",
      "Relation types: supports, challenges, causes, enables, contrasts_with, part_of, precedes, prerequisite_for, explains.",
      "A relation endpoint must be a concept or claim local key from this response.",
      "Never fill a quota. An empty concepts or relations array is valid when the section does not support them.",
    ].join(" "),
    user: `Module: ${module.title}\nGoal: ${module.learningGoal}\n\n${source}`,
  };
}

async function extractFragment(runtime: LearningIrRuntime, module: CourseModule, chunks: SourceChunk[]) {
  const prompt = fragmentPrompt(module, chunks);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const value = await runtime.client.chatJson({
        model: runtime.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: attempt ? `${prompt.user.slice(0, Math.floor(prompt.user.length / 2))}\n\nThe previous response was invalid. Return a smaller valid JSON object.` : prompt.user },
        ],
        temperature: 0.1,
        maxTokens: 2600,
        timeoutMs: 180_000,
        thinking: "disabled",
      });
      if (value && typeof value === "object") return value as CandidateFragment;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.warn("Learning IR extraction degraded for one module", (lastError as Error).message);
  return null;
}

function safeCandidateArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => Boolean(item && typeof item === "object")) : [];
}

function normalizeFragment(fragment: CandidateFragment, module: CourseModule, chunks: SourceChunk[], fallback: CandidateFragment) {
  const validRefs = new Set(chunks.map((chunk) => chunk.id));
  const refs = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && validRefs.has(id)))] : [];
  const concepts = safeCandidateArray<CandidateConcept>(fragment.concepts).slice(0, 8).flatMap((item, index) => {
    const sourceChunkIds = refs(item.sourceChunkIds);
    if (!item.label?.trim() || !item.definition?.trim() || !item.whyItMatters?.trim() || !sourceChunkIds.length) return [];
    return [{ ...item, key: item.key || `concept-${index + 1}`, sourceChunkIds }];
  });
  const claims = safeCandidateArray<CandidateClaim>(fragment.claims).slice(0, 12).flatMap((item, index) => {
    const sourceChunkIds = refs(item.sourceChunkIds);
    if (!item.statement?.trim() || !sourceChunkIds.length) return [];
    return [{ ...item, key: item.key || `claim-${index + 1}`, sourceChunkIds }];
  });
  const nodeKeys = new Set([...concepts.map((item) => item.key), ...claims.map((item) => item.key)]);
  const relations = safeCandidateArray<CandidateRelation>(fragment.relations).slice(0, 16).flatMap((item) => {
    const sourceChunkIds = refs(item.sourceChunkIds);
    if (!nodeKeys.has(item.fromKey) || !nodeKeys.has(item.toKey) || !sourceChunkIds.length) return [];
    return [{ ...item, sourceChunkIds }];
  });
  return {
    kind: fragment.kind || fallback.kind || sectionKind(chunks.map((chunk) => chunk.text).join(" ")),
    concepts: concepts.length ? concepts : fallback.concepts || [],
    claims: claims.length ? claims : fallback.claims || [],
    relations: concepts.length || claims.length ? relations : fallback.relations || [],
  } satisfies CandidateFragment;
}

export type CompileLearningIrInput = {
  materialId: string;
  documentType: LearningDocumentType;
  sourceCount: number;
  chunks: SourceChunk[];
  coursePlan: CoursePlan;
  legacyConcepts: Concept[];
  runtime?: LearningIrRuntime;
  generatedAt?: string;
};

export async function compileLearningIr(input: CompileLearningIrInput): Promise<SourceSemanticIr> {
  const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const sections: SourceSemanticIr["sections"] = [];
  const concepts: LearningConcept[] = [];
  const claims: LearningClaim[] = [];
  const relations: LearningRelation[] = [];

  for (const module of input.coursePlan.modules) {
    const chunks = moduleChunks(module, chunksById);
    if (!chunks.length) continue;
    const fallback = fallbackFragment(module, chunks, input.legacyConcepts);
    const extracted = input.runtime ? await extractFragment(input.runtime, module, chunks) : null;
    const fragment = normalizeFragment(extracted || fallback, module, chunks, fallback);
    const keyToId = new Map<string, string>();
    for (const item of fragment.concepts || []) {
      const id = stableLearningId("concept", input.materialId, module.id, item.sourceChunkIds, item.label);
      keyToId.set(item.key, id);
      concepts.push({ id, label: item.label, definition: item.definition, whyItMatters: item.whyItMatters, sourceChunkIds: item.sourceChunkIds });
    }
    for (const item of fragment.claims || []) {
      const id = stableLearningId("claim", input.materialId, module.id, item.sourceChunkIds, `${item.role}:${item.statement}`);
      keyToId.set(item.key, id);
      claims.push({ id, role: item.role, statement: item.statement, sourceChunkIds: item.sourceChunkIds });
    }
    for (const item of fragment.relations || []) {
      const fromId = keyToId.get(item.fromKey);
      const toId = keyToId.get(item.toKey);
      if (!fromId || !toId) continue;
      relations.push({
        id: stableLearningId("relation", input.materialId, module.id, item.sourceChunkIds, `${fromId}:${toId}:${item.type}`),
        fromId,
        toId,
        type: item.type,
        label: item.label,
        sourceChunkIds: item.sourceChunkIds,
      });
    }
    const kind = fragment.kind || "expository_conceptual";
    sections.push({
      id: stableLearningId("section", input.materialId, module.id, chunks.map((chunk) => chunk.id), module.title),
      moduleId: module.id,
      title: module.title,
      kind,
      sourceChunkIds: chunks.map((chunk) => chunk.id),
      conceptIds: [],
      claimIds: [],
      relationIds: [],
      visualCandidateKinds: visualCandidatesForSection(kind),
    });
  }

  const sourceFingerprint = learningSourceFingerprint(input.chunks, input.documentType);
  const generatedAt = input.generatedAt || new Date().toISOString();
  const candidate = {
    schemaVersion: LEARNING_IR_SCHEMA_VERSION,
    materialId: input.materialId,
    documentType: input.documentType,
    sourceFingerprint,
    generatedAt,
    generator: {
      model: input.runtime?.model || "deterministic-fallback",
      compilerVersion: LEARNING_IR_COMPILER_VERSION,
      promptVersion: LEARNING_IR_PROMPT_VERSION,
    },
    sections,
    concepts,
    claims,
    relations,
  };
  // Ensure the compiler output is plain JSON before it crosses persistence/RPC boundaries.
  return validateLearningIr(JSON.parse(canonicalJson(candidate)), input.chunks);
}
